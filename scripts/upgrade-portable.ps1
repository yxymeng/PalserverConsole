[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$NewPackage,
    [string]$InstallRoot = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-Directory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PathValue,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $item = Get-Item -LiteralPath $PathValue -ErrorAction Stop
    if (-not $item.PSIsContainer) {
        throw "$Label must be a directory: $PathValue"
    }
    return $item.FullName
}

function Read-BuildMetadata {
    param([Parameter(Mandatory = $true)][string]$PackageRoot)

    $metadataPath = Join-Path $PackageRoot "metadata\build-info.json"
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
        throw "BUILD_METADATA_MISSING: $metadataPath"
    }
    try {
        $metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        throw "BUILD_METADATA_INVALID: $metadataPath ($($_.Exception.Message))"
    }
    if ($metadata.formatVersion -ne 1 -or $metadata.application -ne "PalServerConsole") {
        throw "BUILD_METADATA_INVALID: unsupported portable package metadata."
    }
    if ($metadata.architecture -ne "x64") {
        throw "BUILD_METADATA_INVALID: the candidate is not an x64 package."
    }
    if ($null -eq $metadata.database -or $null -eq $metadata.database.maximumSchemaVersion) {
        throw "BUILD_METADATA_INVALID: database.maximumSchemaVersion is missing."
    }
    try {
        $maximumSchemaVersion = [int]$metadata.database.maximumSchemaVersion
    }
    catch {
        throw "BUILD_METADATA_INVALID: database.maximumSchemaVersion is not an integer."
    }
    if ($maximumSchemaVersion -lt 0) {
        throw "BUILD_METADATA_INVALID: database.maximumSchemaVersion must not be negative."
    }
    return [pscustomobject]@{
        Version = [string]$metadata.version
        MaximumSchemaVersion = $maximumSchemaVersion
    }
}

function Assert-PackageChecksums {
    param([Parameter(Mandatory = $true)][string]$PackageRoot)

    $manifestPath = Join-Path $PackageRoot "checksums.sha256"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "CHECKSUM_MANIFEST_MISSING: $manifestPath"
    }
    $rootPath = [System.IO.Path]::GetFullPath($PackageRoot).TrimEnd([char]'\')
    $rootPrefix = "$rootPath\"
    $dataPrefix = "$rootPath\data\"
    $listedPaths = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $entries = @(
        foreach ($line in Get-Content -LiteralPath $manifestPath -Encoding ASCII) {
            if ([string]::IsNullOrWhiteSpace($line)) {
                continue
            }
            if ($line -notmatch '^(?<hash>[0-9A-Fa-f]{64}) \*(?<relative>.+)$') {
                throw "CHECKSUM_MANIFEST_INVALID: $manifestPath"
            }
            $relativePath = $Matches.relative.Replace("\", "/")
            if (
                [System.IO.Path]::IsPathRooted($relativePath) -or
                $relativePath -match '(^|/)\.\.(/|$)' -or
                $relativePath.StartsWith("/") -or
                $relativePath.StartsWith("data/", [System.StringComparison]::OrdinalIgnoreCase) -or
                [string]::Equals(
                    $relativePath,
                    "checksums.sha256",
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            ) {
                throw "CHECKSUM_MANIFEST_INVALID: unsafe path $relativePath"
            }
            if (-not $listedPaths.Add($relativePath)) {
                throw "CHECKSUM_MANIFEST_INVALID: duplicate path $relativePath"
            }
            $candidatePath = [System.IO.Path]::GetFullPath(
                (Join-Path $PackageRoot $relativePath.Replace("/", "\"))
            )
            if (-not $candidatePath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "CHECKSUM_MANIFEST_INVALID: path escapes the package root."
            }
            if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
                throw "CHECKSUM_MISMATCH: missing $relativePath"
            }
            $actualHash = (Get-FileHash -LiteralPath $candidatePath -Algorithm SHA256).Hash
            if (-not [string]::Equals($actualHash, $Matches.hash, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "CHECKSUM_MISMATCH: $relativePath"
            }
            [pscustomobject]@{
                RelativePath = $relativePath
                Hash = $Matches.hash.ToLowerInvariant()
            }
        }
    )
    if ($entries.Count -eq 0) {
        throw "CHECKSUM_MANIFEST_INVALID: the manifest has no files."
    }
    $actualPaths = @(
        Get-ChildItem -LiteralPath $PackageRoot -File -Recurse -Force |
            Where-Object {
                -not $_.FullName.StartsWith(
                    $dataPrefix,
                    [System.StringComparison]::OrdinalIgnoreCase
                ) -and
                -not [string]::Equals(
                    $_.FullName,
                    $manifestPath,
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            } |
            ForEach-Object {
                $_.FullName.Substring($rootPath.Length).TrimStart([char]'\').Replace("\", "/")
            }
    )
    foreach ($actualPath in $actualPaths) {
        if (-not $listedPaths.Contains($actualPath)) {
            throw "CHECKSUM_MANIFEST_INVALID: unlisted file $actualPath"
        }
    }
    if ($actualPaths.Count -ne $listedPaths.Count) {
        throw "CHECKSUM_MANIFEST_INVALID: package file set does not match checksums.sha256."
    }
    return $entries
}

function Assert-ProgramChecksums {
    param(
        [Parameter(Mandatory = $true)][string]$ProgramRoot,
        [Parameter(Mandatory = $true)][object[]]$ProgramEntries
    )

    $expectedPaths = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($entry in $ProgramEntries) {
        $relativePath = [string]$entry.RelativePath
        $insideProgram = $relativePath.Substring("Program/".Length)
        $expectedPaths.Add($insideProgram) | Out-Null
        $target = Join-Path $ProgramRoot $insideProgram.Replace("/", "\")
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
            throw "CHECKSUM_MISMATCH: missing $relativePath after staging."
        }
        $actualHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
        if (-not [string]::Equals($actualHash, [string]$entry.Hash, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "CHECKSUM_MISMATCH: $relativePath after staging."
        }
    }
    $programRootPath = [System.IO.Path]::GetFullPath($ProgramRoot).TrimEnd([char]'\')
    $actualPaths = @(
        Get-ChildItem -LiteralPath $ProgramRoot -File -Recurse -Force |
            ForEach-Object {
                $_.FullName.Substring($programRootPath.Length).TrimStart([char]'\').Replace("\", "/")
            }
    )
    foreach ($actualPath in $actualPaths) {
        if (-not $expectedPaths.Contains($actualPath)) {
            throw "CHECKSUM_MISMATCH: unlisted file Program/$actualPath after staging."
        }
    }
    if ($actualPaths.Count -ne $expectedPaths.Count) {
        throw "CHECKSUM_MISMATCH: staged Program file set does not match checksums.sha256."
    }
}

function Get-DatabaseSchemaVersion {
    param([Parameter(Mandatory = $true)][string]$DatabasePath)

    $stream = [System.IO.File]::Open(
        $DatabasePath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::ReadWrite
    )
    try {
        $header = New-Object byte[] 100
        $bytesRead = $stream.Read($header, 0, $header.Length)
    }
    finally {
        $stream.Dispose()
    }
    $magic = [System.Text.Encoding]::ASCII.GetString($header, 0, 16)
    if ($bytesRead -lt 100 -or $magic -ne "SQLite format 3`0") {
        throw "DATABASE_INVALID: app.db is not a readable SQLite database."
    }
    return [uint32](($header[60] -shl 24) -bor ($header[61] -shl 16) -bor ($header[62] -shl 8) -bor $header[63])
}

function Backup-Database {
    param(
        [Parameter(Mandatory = $true)][string]$DataDirectory,
        [Parameter(Mandatory = $true)][string]$DatabasePath,
        [Parameter(Mandatory = $true)][uint32]$SchemaVersion,
        [Parameter(Mandatory = $true)][string]$Timestamp
    )

    $backupDirectory = Join-Path $DataDirectory "upgrade-backups\$Timestamp"
    New-Item -ItemType Directory -Path $backupDirectory | Out-Null
    $backupPath = Join-Path $backupDirectory "app.db"
    Copy-Item -LiteralPath $DatabasePath -Destination $backupPath
    $manifest = [ordered]@{
        createdAt = (Get-Date).ToUniversalTime().ToString("o")
        source = "app.db"
        schemaVersion = $SchemaVersion
        sha256 = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupDirectory "backup-info.json") -Encoding UTF8
    return $backupDirectory
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot "Program") -PathType Container) {
        $PSScriptRoot
    }
    else {
        Split-Path -Parent $PSScriptRoot
    }
}

$installRootPath = Resolve-Directory $InstallRoot "安装目录"
$packageRootPath = Resolve-Directory $NewPackage "新版本目录"
if ([string]::Equals($installRootPath, $packageRootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "UPGRADE_INPUT_INVALID: install root and new package must be different directories."
}

$installedProgram = Join-Path $installRootPath "Program"
$candidateProgram = Join-Path $packageRootPath "Program"
if (-not (Test-Path -LiteralPath $installedProgram -PathType Container)) {
    throw "UPGRADE_INPUT_INVALID: installed Program directory is missing: $installedProgram"
}
if (-not (Test-Path -LiteralPath $candidateProgram -PathType Container)) {
    throw "UPGRADE_INPUT_INVALID: candidate Program directory is missing: $candidateProgram"
}

$metadata = Read-BuildMetadata $packageRootPath
$entries = Assert-PackageChecksums $packageRootPath
$programEntries = @($entries | Where-Object { $_.RelativePath -like "Program/*" })
if ($programEntries.Count -eq 0) {
    throw "CHECKSUM_MANIFEST_INVALID: Program files are missing from checksums.sha256."
}

$running = @(Get-Process -Name "PalServerConsole" -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    throw "CONSOLE_RUNNING: close PalServerConsole before upgrading."
}

$dataDirectory = Join-Path $installRootPath "data"
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$databasePath = Join-Path $dataDirectory "app.db"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
if (Test-Path -LiteralPath $databasePath -PathType Leaf) {
    foreach ($sidecar in @("$databasePath-wal", "$databasePath-shm", "$databasePath-journal")) {
        if (Test-Path -LiteralPath $sidecar -PathType Leaf) {
            throw "DATABASE_SIDECAR_PRESENT: $sidecar. Start the existing console once, stop it normally, then retry."
        }
    }
    $currentSchemaVersion = Get-DatabaseSchemaVersion $databasePath
    if ($currentSchemaVersion -gt $metadata.MaximumSchemaVersion) {
        throw (
            "INCOMPATIBLE_DOWNGRADE: current data app.db schema version $currentSchemaVersion " +
            "is newer than candidate support $($metadata.MaximumSchemaVersion)."
        )
    }
    $databaseBackup = Backup-Database $dataDirectory $databasePath $currentSchemaVersion $timestamp
    Write-Host "已创建数据库升级前备份：$databaseBackup"
}

$stagingProgram = Join-Path $installRootPath ".Program-upgrade-staging-$timestamp"
New-Item -ItemType Directory -Path $stagingProgram | Out-Null
try {
    foreach ($item in Get-ChildItem -LiteralPath $candidateProgram -Force) {
        Copy-Item -LiteralPath $item.FullName -Destination $stagingProgram -Recurse -Force
    }
    Assert-ProgramChecksums $stagingProgram $programEntries
}
catch {
    throw "UPGRADE_STAGING_FAILED: $($_.Exception.Message)"
}

$programBackups = Join-Path $installRootPath "program-backups"
New-Item -ItemType Directory -Path $programBackups -Force | Out-Null
$previousProgram = Join-Path $programBackups "Program-$timestamp"
$oldProgramMoved = $false
$newProgramMoved = $false
try {
    Move-Item -LiteralPath $installedProgram -Destination $previousProgram
    $oldProgramMoved = $true
    Move-Item -LiteralPath $stagingProgram -Destination $installedProgram
    $newProgramMoved = $true
    Assert-ProgramChecksums $installedProgram $programEntries
}
catch {
    $upgradeError = $_.Exception.Message
    try {
        if ($newProgramMoved -and (Test-Path -LiteralPath $installedProgram -PathType Container)) {
            $failedProgram = Join-Path $programBackups "Program-failed-$timestamp"
            Move-Item -LiteralPath $installedProgram -Destination $failedProgram
        }
        if ($oldProgramMoved -and (Test-Path -LiteralPath $previousProgram -PathType Container)) {
            Move-Item -LiteralPath $previousProgram -Destination $installedProgram
        }
    }
    catch {
        throw "PROGRAM_ROLLBACK_FAILED: $($_.Exception.Message) Original upgrade error: $upgradeError"
    }
    throw "UPGRADE_FAILED: $upgradeError. Program rollback completed; data was not modified."
}

Write-Host "升级完成：已替换 Program，data 未被替换。旧程序保留在 $previousProgram。"
