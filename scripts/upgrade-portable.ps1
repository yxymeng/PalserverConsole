[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$NewPackage,
    [string]$InstallRoot = "",
    [string]$DataDirectory = "",
    [string]$UpdateLockId = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-Sha256Hash {
    param([Parameter(Mandatory = $true)][string]$PathValue)

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($PathValue)
        try {
            return [System.BitConverter]::ToString(
                $sha256.ComputeHash($stream)
            ).Replace("-", "").ToLowerInvariant()
        }
        finally {
            $stream.Dispose()
        }
    }
    finally {
        $sha256.Dispose()
    }
}

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

function Get-CurrentInstallConsoleProcesses {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallRootPath
    )

    $launcherPaths = @(
        [System.IO.Path]::GetFullPath((Join-Path $InstallRootPath "PalServerConsole.exe")),
        [System.IO.Path]::GetFullPath((Join-Path $InstallRootPath "Program\PalServerConsole.exe"))
    )
    foreach ($process in @(Get-Process -Name "PalServerConsole" -ErrorAction SilentlyContinue)) {
        try {
            $processPath = [System.IO.Path]::GetFullPath($process.MainModule.FileName)
            if ($launcherPaths -contains $processPath) {
                $process
            }
        }
        catch {
            continue
        }
    }
}

function Open-InstallUpdateGuard {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallRootPath
    )

    $guardPath = [System.IO.Path]::GetFullPath(
        (Join-Path $InstallRootPath ".palserver-console-update.guard")
    )
    while ($true) {
        try {
            return [System.IO.File]::Open(
                $guardPath,
                [System.IO.FileMode]::OpenOrCreate,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None
            )
        }
        catch [System.IO.IOException] {
            $win32Code = $_.Exception.HResult -band 0xFFFF
            if ($win32Code -eq 32 -or $win32Code -eq 33) {
                Start-Sleep -Milliseconds 50
                continue
            }
            throw (
                "UPDATE_GUARD_UNAVAILABLE: unable to acquire installation update guard. " +
                $_.Exception.Message
            )
        }
        catch {
            throw (
                "UPDATE_GUARD_UNAVAILABLE: unable to acquire installation update guard. " +
                $_.Exception.Message
            )
        }
    }
}

function Write-UpdateLockJsonAtomically {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$UpdateLockPath,
        [Parameter(Mandatory = $true)][string]$Json,
        [Parameter(Mandatory = $true)]
        [ValidateSet("Create", "Replace")]
        [string]$Mode
    )

    $fullLockPath = [System.IO.Path]::GetFullPath($UpdateLockPath)
    $lockDirectory = [System.IO.Path]::GetDirectoryName($fullLockPath)
    if ([string]::IsNullOrEmpty($lockDirectory)) {
        throw "UPDATE_LOCK_INVALID: application update lock directory is unavailable."
    }
    $temporaryPath = Join-Path $lockDirectory (
        ".{0}.tmp-{1}" -f [System.IO.Path]::GetFileName($fullLockPath), [guid]::NewGuid().ToString("N")
    )
    $backupPath = $null
    $stream = $null
    try {
        $utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
        $bytes = $utf8NoBom.GetBytes($Json)
        $stream = [System.IO.File]::Open(
            $temporaryPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null

        if ($Mode -eq "Create") {
            if (Test-Path -LiteralPath $fullLockPath) {
                throw "UPDATE_LOCK_IN_PROGRESS: application update lock already exists."
            }
            [System.IO.File]::Move($temporaryPath, $fullLockPath)
        }
        else {
            if (-not (Test-Path -LiteralPath $fullLockPath -PathType Leaf)) {
                throw "UPDATE_LOCK_MISSING: application update lock is missing."
            }
            $backupPath = Join-Path $lockDirectory (
                ".{0}.backup-{1}" -f [System.IO.Path]::GetFileName($fullLockPath), [guid]::NewGuid().ToString("N")
            )
            [System.IO.File]::Replace($temporaryPath, $fullLockPath, $backupPath)
            Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
        }
    }
    finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        if ($null -ne $backupPath) {
            Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Read-UpdateLockJson {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$UpdateLockPath
    )

    try {
        return Get-Content -LiteralPath $UpdateLockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        throw "UPDATE_LOCK_INVALID: application update lock is unreadable."
    }
}

function Assert-UpdateLockMetadataComplete {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Lock
    )

    foreach ($propertyName in @("lockId", "pid", "processStartedAt", "phase", "instanceId", "createdAt")) {
        if ($null -eq $Lock.PSObject.Properties[$propertyName]) {
            throw "UPDATE_LOCK_INVALID: application update lock metadata is incomplete."
        }
    }
    if (
        [string]::IsNullOrWhiteSpace([string]$Lock.lockId) -or
        [string]::IsNullOrWhiteSpace([string]$Lock.phase) -or
        [string]::IsNullOrWhiteSpace([string]$Lock.instanceId)
    ) {
        throw "UPDATE_LOCK_INVALID: application update lock metadata is incomplete."
    }
    try {
        if ([long]$Lock.pid -le 0) {
            throw "invalid pid"
        }
        $processStartedAt = [double]$Lock.processStartedAt
        $createdAt = [double]$Lock.createdAt
        if (
            [double]::IsNaN($processStartedAt) -or
            [double]::IsInfinity($processStartedAt) -or
            $processStartedAt -le 0 -or
            [double]::IsNaN($createdAt) -or
            [double]::IsInfinity($createdAt) -or
            $createdAt -le 0
        ) {
            throw "invalid timestamps"
        }
    }
    catch {
        throw "UPDATE_LOCK_INVALID: application update lock metadata is incomplete."
    }
}

function New-ManualUpdateLock {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$UpdateLockPath,
        [Parameter(Mandatory = $true)][string]$InstallRootPath
    )

    $guard = $null
    try {
        $guard = Open-InstallUpdateGuard -InstallRootPath $InstallRootPath
        if (Test-Path -LiteralPath $UpdateLockPath) {
            throw "UPDATE_LOCK_IN_PROGRESS: another application update is already in progress."
        }
        $lockId = [guid]::NewGuid().ToString("N")
        $processStartedAt = [DateTimeOffset]::new(
            (Get-Process -Id $PID).StartTime.ToUniversalTime()
        ).ToUnixTimeMilliseconds() / 1000.0
        $lockJson = [ordered]@{
            lockId = $lockId
            pid = $PID
            processStartedAt = $processStartedAt
            phase = "manual-upgrade"
            instanceId = "manual"
            createdAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000.0
        } | ConvertTo-Json
        Write-UpdateLockJsonAtomically `
            -UpdateLockPath $UpdateLockPath `
            -Json $lockJson `
            -Mode Create
        return $lockId
    }
    finally {
        if ($null -ne $guard) {
            $guard.Dispose()
        }
    }
}

function Assert-ExistingUpdateLockOwner {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$UpdateLockPath,
        [Parameter(Mandatory = $true)][string]$ExpectedLockId,
        [Parameter(Mandatory = $true)][string]$InstallRootPath
    )

    $guard = $null
    try {
        $guard = Open-InstallUpdateGuard -InstallRootPath $InstallRootPath
        if (-not (Test-Path -LiteralPath $UpdateLockPath -PathType Leaf)) {
            throw "UPDATE_LOCK_MISSING: application update lock is missing."
        }
        $lock = Read-UpdateLockJson -UpdateLockPath $UpdateLockPath
        if ($null -eq $lock) {
            throw "UPDATE_LOCK_INVALID: application update lock is unreadable."
        }
        Assert-UpdateLockMetadataComplete -Lock $lock
        $lockIdProperty = $lock.PSObject.Properties["lockId"]
        $phaseProperty = $lock.PSObject.Properties["phase"]
        if (
            $null -eq $lockIdProperty -or
            [string]::IsNullOrWhiteSpace([string]$lockIdProperty.Value) -or
            $null -eq $phaseProperty -or
            [string]::IsNullOrWhiteSpace([string]$phaseProperty.Value)
        ) {
            throw "UPDATE_LOCK_INVALID: application update lock metadata is incomplete."
        }
        if ([string]$lockIdProperty.Value -ne $ExpectedLockId) {
            throw "UPDATE_LOCK_OWNERSHIP_LOST: application update lock belongs to another update."
        }
        if ([string]$phaseProperty.Value -ne "helper") {
            throw "UPDATE_LOCK_OWNERSHIP_LOST: application update lock is not owned by the automatic helper."
        }
    }
    finally {
        if ($null -ne $guard) {
            $guard.Dispose()
        }
    }
}

function Remove-UpdateLockIfOwned {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$UpdateLockPath,
        [Parameter(Mandatory = $true)][string]$ExpectedLockId,
        [Parameter(Mandatory = $true)][string]$InstallRootPath
    )

    $guard = $null
    try {
        $guard = Open-InstallUpdateGuard -InstallRootPath $InstallRootPath
        if (-not (Test-Path -LiteralPath $UpdateLockPath -PathType Leaf)) {
            return
        }
        $lock = Read-UpdateLockJson -UpdateLockPath $UpdateLockPath
        if ($null -eq $lock) {
            throw "UPDATE_LOCK_INVALID: application update lock is unreadable."
        }
        Assert-UpdateLockMetadataComplete -Lock $lock
        $lockIdProperty = $lock.PSObject.Properties["lockId"]
        if (
            $null -eq $lockIdProperty -or
            [string]::IsNullOrWhiteSpace([string]$lockIdProperty.Value)
        ) {
            throw "UPDATE_LOCK_INVALID: application update lock metadata is incomplete."
        }
        if ([string]$lockIdProperty.Value -ne $ExpectedLockId) {
            throw "UPDATE_LOCK_OWNERSHIP_LOST: application update lock belongs to another update."
        }
        if ([string]$lock.phase -ne "manual-upgrade") {
            throw "UPDATE_LOCK_OWNERSHIP_LOST: application update lock is not owned by manual upgrade."
        }
        Remove-Item -LiteralPath $UpdateLockPath -Force -ErrorAction Stop
    }
    finally {
        if ($null -ne $guard) {
            $guard.Dispose()
        }
    }
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
            $actualHash = Get-Sha256Hash -PathValue $candidatePath
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
        $actualHash = Get-Sha256Hash -PathValue $target
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

function Assert-LauncherChecksum {
    param(
        [Parameter(Mandatory = $true)][string]$LauncherPath,
        [Parameter(Mandatory = $true)][object]$LauncherEntry,
        [Parameter(Mandatory = $true)][string]$Context
    )

    if (-not (Test-Path -LiteralPath $LauncherPath -PathType Leaf)) {
        throw "CHECKSUM_MISMATCH: missing PalServerConsole.exe $Context."
    }
    $actualHash = Get-Sha256Hash -PathValue $LauncherPath
    if (-not [string]::Equals($actualHash, [string]$LauncherEntry.Hash, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "CHECKSUM_MISMATCH: PalServerConsole.exe $Context."
    }
}

function Get-ReleaseManagedEntry {
    param(
        [Parameter(Mandatory = $true)][object[]]$Entries,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    $matches = @(
        $Entries | Where-Object {
            [string]::Equals(
                [string]$_.RelativePath,
                $RelativePath,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        }
    )
    if ($matches.Count -ne 1) {
        throw "CHECKSUM_MANIFEST_INVALID: $RelativePath must appear exactly once."
    }
    return $matches[0]
}

function Assert-ReleaseManagedFileChecksum {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][object]$Entry,
        [Parameter(Mandatory = $true)][string]$Context
    )

    $relativePath = [string]$Entry.RelativePath
    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        throw "CHECKSUM_MISMATCH: missing $relativePath $Context."
    }
    $actualHash = Get-Sha256Hash -PathValue $FilePath
    if (-not [string]::Equals($actualHash, [string]$Entry.Hash, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "CHECKSUM_MISMATCH: $relativePath $Context."
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
        sha256 = Get-Sha256Hash -PathValue $backupPath
    }
    $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupDirectory "backup-info.json") -Encoding UTF8
    return $backupDirectory
}

function Test-ReparsePoint {
    param([Parameter(Mandatory = $true)][System.IO.FileSystemInfo]$Item)

    return (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Get-ManagedDatabaseCandidates {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRootPath,
        [Parameter(Mandatory = $true)][string]$DataDirectoryPath
    )

    $candidates = [System.Collections.Generic.List[object]]::new()
    $seenPaths = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $addCandidate = {
        param(
            [Parameter(Mandatory = $true)][string]$DatabasePath,
            [Parameter(Mandatory = $true)][string]$OwnerDataDirectory
        )

        try {
            $database = Get-Item -LiteralPath $DatabasePath -Force -ErrorAction SilentlyContinue
        }
        catch {
            throw "DATABASE_UNAVAILABLE: cannot inspect $DatabasePath ($($_.Exception.Message))"
        }
        if ($null -eq $database -or $database.PSIsContainer -or (Test-ReparsePoint $database)) {
            return
        }
        $fullDatabasePath = [System.IO.Path]::GetFullPath($database.FullName)
        if ($seenPaths.Add($fullDatabasePath)) {
            [void]$candidates.Add([pscustomobject]@{
                DatabasePath = $fullDatabasePath
                DataDirectory = [System.IO.Path]::GetFullPath($OwnerDataDirectory)
            })
        }
    }

    $installDataDirectory = Join-Path $InstallRootPath "data"
    $installDataItem = Get-Item -LiteralPath $installDataDirectory -Force -ErrorAction SilentlyContinue
    if ($null -ne $installDataItem -and $installDataItem.PSIsContainer -and -not (Test-ReparsePoint $installDataItem)) {
        & $addCandidate (Join-Path $installDataDirectory "app.db") $installDataDirectory
        $instancesDirectory = Join-Path $installDataDirectory "instances"
        $instancesItem = Get-Item -LiteralPath $instancesDirectory -Force -ErrorAction SilentlyContinue
        if ($null -ne $instancesItem -and $instancesItem.PSIsContainer -and -not (Test-ReparsePoint $instancesItem)) {
            foreach ($instance in @(Get-ChildItem -LiteralPath $instancesDirectory -Directory -Force)) {
                if (Test-ReparsePoint $instance) {
                    continue
                }
                & $addCandidate (Join-Path $instance.FullName "app.db") $instance.FullName
            }
        }
    }

    $explicitDataItem = Get-Item -LiteralPath $DataDirectoryPath -Force -ErrorAction SilentlyContinue
    if ($null -ne $explicitDataItem -and $explicitDataItem.PSIsContainer -and -not (Test-ReparsePoint $explicitDataItem)) {
        & $addCandidate (Join-Path $DataDirectoryPath "app.db") $DataDirectoryPath
    }
    return @($candidates)
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
$installedLauncher = Join-Path $installRootPath "PalServerConsole.exe"
$candidateLauncher = Join-Path $packageRootPath "PalServerConsole.exe"
$installedUpdateHelper = Join-Path $installRootPath "apply-downloaded-update.ps1"
$candidateUpdateHelper = Join-Path $packageRootPath "apply-downloaded-update.ps1"
$installedUpgradeScript = Join-Path $installRootPath "upgrade-portable.ps1"
$candidateUpgradeScript = Join-Path $packageRootPath "upgrade-portable.ps1"
$updateLockPath = Join-Path $installRootPath ".palserver-console-update.lock"
$ownsManualUpdateLock = $false
$manualUpdateLockId = ""

try {
    if ([string]::IsNullOrWhiteSpace($UpdateLockId)) {
        $manualUpdateLockId = New-ManualUpdateLock `
            -UpdateLockPath $updateLockPath `
            -InstallRootPath $installRootPath
        $ownsManualUpdateLock = $true
    }
    else {
        Assert-ExistingUpdateLockOwner `
            -UpdateLockPath $updateLockPath `
            -ExpectedLockId $UpdateLockId `
            -InstallRootPath $installRootPath
    }

if (-not (Test-Path -LiteralPath $installedProgram -PathType Container)) {
    throw "UPGRADE_INPUT_INVALID: installed Program directory is missing: $installedProgram"
}
if (-not (Test-Path -LiteralPath $candidateProgram -PathType Container)) {
    throw "UPGRADE_INPUT_INVALID: candidate Program directory is missing: $candidateProgram"
}
if (-not (Test-Path -LiteralPath $candidateLauncher -PathType Leaf)) {
    throw "UPGRADE_INPUT_INVALID: candidate root launcher is missing: $candidateLauncher"
}

$metadata = Read-BuildMetadata $packageRootPath
$entries = Assert-PackageChecksums $packageRootPath
$programEntries = @($entries | Where-Object { $_.RelativePath -like "Program/*" })
$launcherEntries = @(
    $entries | Where-Object {
        [string]::Equals(
            [string]$_.RelativePath,
            "PalServerConsole.exe",
            [System.StringComparison]::OrdinalIgnoreCase
        )
    }
)
if ($programEntries.Count -eq 0) {
    throw "CHECKSUM_MANIFEST_INVALID: Program files are missing from checksums.sha256."
}
if ($launcherEntries.Count -ne 1) {
    throw "CHECKSUM_MANIFEST_INVALID: root PalServerConsole.exe must appear exactly once."
}
$launcherEntry = $launcherEntries[0]
$updateHelperEntry = Get-ReleaseManagedEntry $entries "apply-downloaded-update.ps1"
$upgradeScriptEntry = Get-ReleaseManagedEntry $entries "upgrade-portable.ps1"
Assert-ReleaseManagedFileChecksum $candidateUpdateHelper $updateHelperEntry "in candidate"
Assert-ReleaseManagedFileChecksum $candidateUpgradeScript $upgradeScriptEntry "in candidate"

$currentInstallProcesses = @(Get-CurrentInstallConsoleProcesses -InstallRootPath $installRootPath)
if ($currentInstallProcesses.Count -gt 0) {
    throw "CONSOLE_RUNNING: close PalServerConsole before upgrading."
}

if ([string]::IsNullOrWhiteSpace($DataDirectory)) {
    $dataDirectory = Join-Path $installRootPath "data"
}
else {
    $dataDirectory = [System.IO.Path]::GetFullPath($DataDirectory)
}
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$databaseCandidates = @(Get-ManagedDatabaseCandidates $installRootPath $dataDirectory)
$databaseRecords = [System.Collections.Generic.List[object]]::new()
foreach ($candidate in $databaseCandidates) {
    $databasePath = [string]$candidate.DatabasePath
    foreach ($sidecar in @("$databasePath-wal", "$databasePath-shm", "$databasePath-journal")) {
        if (Test-Path -LiteralPath $sidecar -PathType Leaf) {
            throw "DATABASE_SIDECAR_PRESENT: $sidecar. Start the existing console once, stop it normally, then retry."
        }
    }
    $currentSchemaVersion = Get-DatabaseSchemaVersion $databasePath
    if ($currentSchemaVersion -gt $metadata.MaximumSchemaVersion) {
        throw (
            "INCOMPATIBLE_DOWNGRADE: current data app.db schema version $currentSchemaVersion " +
            "at $databasePath is newer than candidate support $($metadata.MaximumSchemaVersion)."
        )
    }
    [void]$databaseRecords.Add([pscustomobject]@{
        DatabasePath = $databasePath
        DataDirectory = [string]$candidate.DataDirectory
        SchemaVersion = [uint32]$currentSchemaVersion
    })
}
foreach ($database in $databaseRecords) {
    $databaseBackup = Backup-Database `
        ([string]$database.DataDirectory) `
        ([string]$database.DatabasePath) `
        ([uint32]$database.SchemaVersion) `
        $timestamp
    Write-Host "已创建数据库升级前备份：$databaseBackup"
}

$stagingProgram = Join-Path $installRootPath ".Program-upgrade-staging-$timestamp"
$stagingLauncher = Join-Path $installRootPath ".PalServerConsole-upgrade-staging-$timestamp.exe"
$stagingUpdateHelper = Join-Path $installRootPath ".apply-downloaded-update-upgrade-staging-$timestamp.ps1"
$stagingUpgradeScript = Join-Path $installRootPath ".upgrade-portable-upgrade-staging-$timestamp.ps1"
New-Item -ItemType Directory -Path $stagingProgram | Out-Null
try {
    foreach ($item in Get-ChildItem -LiteralPath $candidateProgram -Force) {
        Copy-Item -LiteralPath $item.FullName -Destination $stagingProgram -Recurse -Force
    }
    Assert-ProgramChecksums $stagingProgram $programEntries
    Copy-Item -LiteralPath $candidateLauncher -Destination $stagingLauncher
    Assert-LauncherChecksum $stagingLauncher $launcherEntry "after staging"
    Copy-Item -LiteralPath $candidateUpdateHelper -Destination $stagingUpdateHelper
    Assert-ReleaseManagedFileChecksum $stagingUpdateHelper $updateHelperEntry "after staging"
    Copy-Item -LiteralPath $candidateUpgradeScript -Destination $stagingUpgradeScript
    Assert-ReleaseManagedFileChecksum $stagingUpgradeScript $upgradeScriptEntry "after staging"
}
catch {
    throw "UPGRADE_STAGING_FAILED: $($_.Exception.Message)"
}

$programBackups = Join-Path $installRootPath "program-backups"
New-Item -ItemType Directory -Path $programBackups -Force | Out-Null
$previousProgram = Join-Path $programBackups "Program-$timestamp"
$previousLauncher = Join-Path $programBackups "PalServerConsole-$timestamp.exe"
$previousUpdateHelper = Join-Path $programBackups "apply-downloaded-update-$timestamp.ps1"
$previousUpgradeScript = Join-Path $programBackups "upgrade-portable-$timestamp.ps1"
$oldProgramMoved = $false
$newProgramMoved = $false
$oldLauncherMoved = $false
$newLauncherMoved = $false
$oldUpdateHelperMoved = $false
$newUpdateHelperMoved = $false
$oldUpgradeScriptMoved = $false
$newUpgradeScriptMoved = $false
try {
    Move-Item -LiteralPath $installedProgram -Destination $previousProgram
    $oldProgramMoved = $true
    Move-Item -LiteralPath $stagingProgram -Destination $installedProgram
    $newProgramMoved = $true
    if (Test-Path -LiteralPath $installedLauncher -PathType Leaf) {
        Move-Item -LiteralPath $installedLauncher -Destination $previousLauncher
        $oldLauncherMoved = $true
    }
    Move-Item -LiteralPath $stagingLauncher -Destination $installedLauncher
    $newLauncherMoved = $true
    if (Test-Path -LiteralPath $installedUpdateHelper -PathType Leaf) {
        Move-Item -LiteralPath $installedUpdateHelper -Destination $previousUpdateHelper
        $oldUpdateHelperMoved = $true
    }
    Move-Item -LiteralPath $stagingUpdateHelper -Destination $installedUpdateHelper
    $newUpdateHelperMoved = $true
    if (Test-Path -LiteralPath $installedUpgradeScript -PathType Leaf) {
        Move-Item -LiteralPath $installedUpgradeScript -Destination $previousUpgradeScript
        $oldUpgradeScriptMoved = $true
    }
    Move-Item -LiteralPath $stagingUpgradeScript -Destination $installedUpgradeScript
    $newUpgradeScriptMoved = $true
    Assert-ProgramChecksums $installedProgram $programEntries
    Assert-LauncherChecksum $installedLauncher $launcherEntry "after installation"
    Assert-ReleaseManagedFileChecksum $installedUpdateHelper $updateHelperEntry "after installation"
    Assert-ReleaseManagedFileChecksum $installedUpgradeScript $upgradeScriptEntry "after installation"
}
catch {
    $upgradeError = $_.Exception.Message
    try {
        if ($newUpgradeScriptMoved -and (Test-Path -LiteralPath $installedUpgradeScript -PathType Leaf)) {
            $failedUpgradeScript = Join-Path $programBackups "upgrade-portable-failed-$timestamp.ps1"
            Move-Item -LiteralPath $installedUpgradeScript -Destination $failedUpgradeScript
        }
        if ($oldUpgradeScriptMoved -and (Test-Path -LiteralPath $previousUpgradeScript -PathType Leaf)) {
            Move-Item -LiteralPath $previousUpgradeScript -Destination $installedUpgradeScript
        }
        if ($newUpdateHelperMoved -and (Test-Path -LiteralPath $installedUpdateHelper -PathType Leaf)) {
            $failedUpdateHelper = Join-Path $programBackups "apply-downloaded-update-failed-$timestamp.ps1"
            Move-Item -LiteralPath $installedUpdateHelper -Destination $failedUpdateHelper
        }
        if ($oldUpdateHelperMoved -and (Test-Path -LiteralPath $previousUpdateHelper -PathType Leaf)) {
            Move-Item -LiteralPath $previousUpdateHelper -Destination $installedUpdateHelper
        }
        if ($newLauncherMoved -and (Test-Path -LiteralPath $installedLauncher -PathType Leaf)) {
            $failedLauncher = Join-Path $programBackups "PalServerConsole-failed-$timestamp.exe"
            Move-Item -LiteralPath $installedLauncher -Destination $failedLauncher
        }
        if ($oldLauncherMoved -and (Test-Path -LiteralPath $previousLauncher -PathType Leaf)) {
            Move-Item -LiteralPath $previousLauncher -Destination $installedLauncher
        }
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
    throw "UPGRADE_FAILED: $upgradeError. Program, launcher, maintenance scripts, and data were restored."
}

Write-Host "升级完成：已替换根目录启动器、Program 和维护脚本，data 未被替换。旧程序保留在 $previousProgram。"
if (Test-Path -LiteralPath $previousLauncher -PathType Leaf) {
    Write-Host "旧启动器保留在 $previousLauncher。"
}
}
finally {
    if ($ownsManualUpdateLock) {
        Remove-UpdateLockIfOwned `
            -UpdateLockPath $updateLockPath `
            -ExpectedLockId $manualUpdateLockId `
            -InstallRootPath $installRootPath
    }
}
