[CmdletBinding()]
param(
    [string]$OutputDirectory = "",
    [switch]$AllowDirtySource
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-ExitCode {
    param([Parameter(Mandatory = $true)][string]$Description)

    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

function Assert-BuildRuntime {
    param([Parameter(Mandatory = $true)][string]$PythonExecutable)

    $probe = & $PythonExecutable -c 'import json, platform, struct, sys; print(json.dumps(dict(implementation=platform.python_implementation(), major=sys.version_info.major, minor=sys.version_info.minor, bits=struct.calcsize(chr(80))*8, version=platform.python_version())))'
    Assert-ExitCode "Python runtime probe"
    $runtime = ($probe | Out-String | ConvertFrom-Json)
    if ($runtime.implementation -ne "CPython" -or $runtime.major -ne 3 -or $runtime.minor -ne 13 -or $runtime.bits -ne 64) {
        throw "Portable builds require 64-bit CPython 3.13. Detected $($runtime.implementation) $($runtime.version) ($($runtime.bits)-bit)."
    }
    return $runtime
}

function Copy-DirectoryContents {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
        Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse -Force
    }
}

function Write-Checksums {
    param([Parameter(Mandatory = $true)][string]$PackageRoot)

    $rootPath = [System.IO.Path]::GetFullPath($PackageRoot).TrimEnd([char]'\')
    $dataPrefix = "$rootPath\data\"
    $manifestPath = Join-Path $rootPath "checksums.sha256"
    $lines = @(
        Get-ChildItem -LiteralPath $PackageRoot -File -Recurse -Force |
            Where-Object {
                -not $_.FullName.StartsWith($dataPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
                -not [string]::Equals(
                    $_.FullName,
                    $manifestPath,
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            } |
            Sort-Object FullName |
            ForEach-Object {
                $relativePath = $_.FullName.Substring($rootPath.Length).TrimStart([char]'\').Replace("\", "/")
                $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                "$hash *$relativePath"
            }
    )
    if ($lines.Count -eq 0) {
        throw "No release files were staged for checksums."
    }
    Set-Content -LiteralPath $manifestPath -Value $lines -Encoding ASCII
}

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $projectRoot "artifacts"
}
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
$venvPython = Join-Path $projectRoot ".venv\Scripts\python.exe"
$runtimeLock = Join-Path $projectRoot "requirements.lock"
$buildLock = Join-Path $projectRoot "requirements-build.lock"
$frontendRoot = Join-Path $projectRoot "frontend"
$frontendDist = Join-Path $frontendRoot "dist"
$portableEntry = Join-Path $PSScriptRoot "portable-entry.py"
$portableLauncherSource = Join-Path $PSScriptRoot "portable-launcher.cs"
$applicationUpdateHelper = Join-Path $PSScriptRoot "apply-downloaded-update.ps1"
$licenseCollector = Join-Path $PSScriptRoot "collect-third-party-licenses.py"
$projectLicense = Join-Path $projectRoot "LICENSE"
$thirdPartyNotices = Join-Path $projectRoot "THIRD_PARTY_NOTICES.md"
$appIcon = Join-Path $projectRoot "branding\PalServerConsole.ico"

foreach ($required in @($runtimeLock, $buildLock, $portableEntry, $portableLauncherSource, $applicationUpdateHelper, $licenseCollector, $projectLicense, $thirdPartyNotices, $appIcon)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required build input is missing: $required"
    }
}

$gitRevision = "unavailable"
$sourceTreeState = "unavailable"
$git = Get-Command git.exe -ErrorAction SilentlyContinue
if ($null -ne $git) {
    $candidateRevision = (& $git.Source -C $projectRoot rev-parse HEAD 2>$null).Trim()
    if ($LASTEXITCODE -eq 0 -and $candidateRevision) {
        $gitRevision = $candidateRevision
        $statusLines = @(& $git.Source -C $projectRoot status --porcelain --untracked-files=all)
        if ($LASTEXITCODE -ne 0) {
            throw "SOURCE_PROVENANCE_UNAVAILABLE: git status failed."
        }
        $sourceTreeState = if ($statusLines.Count -eq 0) { "clean" } else { "dirty" }
    }
}
if ($sourceTreeState -eq "dirty" -and -not $AllowDirtySource) {
    throw (
        "SOURCE_TREE_DIRTY: release builds require a clean Git worktree. " +
        "Commit the intended source first, or use -AllowDirtySource only for a local validation package."
    )
}
if ($sourceTreeState -eq "unavailable" -and -not $AllowDirtySource) {
    throw (
        "SOURCE_PROVENANCE_UNAVAILABLE: release builds require a Git revision. " +
        "Use -AllowDirtySource only for a local validation package."
    )
}

if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    $systemPython = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($null -eq $systemPython) {
        throw "Python was not found. Install 64-bit CPython 3.13 on the build machine."
    }
    Assert-BuildRuntime $systemPython.Source | Out-Null
    Write-Host "[PalServerConsole] 正在创建 64 位 CPython 3.13 构建环境..."
    & $systemPython.Source -m venv (Join-Path $projectRoot ".venv")
    Assert-ExitCode "python -m venv"
}

$runtime = Assert-BuildRuntime $venvPython
$originalLocation = Get-Location
$temporaryRoot = $null
try {
    Set-Location -LiteralPath $projectRoot
    Write-Host "[PalServerConsole] 正在按锁文件安装 PyInstaller 构建依赖..."
    & $venvPython -m pip install --disable-pip-version-check --require-hashes -r $runtimeLock -r $buildLock
    Assert-ExitCode "pip install --require-hashes"
    & $venvPython -m pip install --disable-pip-version-check --no-deps --no-build-isolation -e $projectRoot
    Assert-ExitCode "pip install -e"

    $pyInstallerVersion = (& $venvPython -m PyInstaller --version).Trim()
    Assert-ExitCode "PyInstaller version probe"
    if ($pyInstallerVersion -ne "6.22.0") {
        throw "Unexpected PyInstaller version $pyInstallerVersion; requirements-build.lock requires 6.22.0."
    }

    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $npm) {
        throw "npm.cmd was not found. Install Node.js 24 LTS on the build machine."
    }
    Set-Location -LiteralPath $frontendRoot
    Write-Host "[PalServerConsole] 正在按 package-lock.json 构建前端..."
    & $npm.Source ci
    Assert-ExitCode "npm.cmd ci"
    & $npm.Source run build
    Assert-ExitCode "npm.cmd run build"
    if (-not (Test-Path -LiteralPath (Join-Path $frontendDist "index.html") -PathType Leaf)) {
        throw "Frontend build is missing index.html after npm.cmd run build."
    }

    Set-Location -LiteralPath $projectRoot
    $runtimeMetadataJson = & $venvPython -c 'import json, platform; from palserver_console import __version__; from palserver_console.persistence import SCHEMA_VERSION; print(json.dumps(dict(version=__version__, pythonVersion=platform.python_version(), schemaVersion=SCHEMA_VERSION)))'
    Assert-ExitCode "Application metadata probe"
    $runtimeMetadata = ($runtimeMetadataJson | Out-String | ConvertFrom-Json)

    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
    $packageName = "PalServerConsole-$($runtimeMetadata.version)-windows-x64"
    $packageRoot = Join-Path $outputRoot $packageName
    $zipPath = Join-Path $outputRoot "$packageName.zip"
    if ((Test-Path -LiteralPath $packageRoot) -or (Test-Path -LiteralPath $zipPath)) {
        throw "Refusing to overwrite an existing portable artifact: $packageName"
    }

    $buildId = [guid]::NewGuid().ToString("N")
    $temporaryRoot = Join-Path $outputRoot ".opt12-build-$buildId"
    $pyInstallerWork = Join-Path $temporaryRoot "work"
    $pyInstallerDist = Join-Path $temporaryRoot "dist"
    $pyInstallerSpec = Join-Path $temporaryRoot "spec"
    $packageStage = Join-Path $temporaryRoot $packageName
    $stagedZipPath = Join-Path $temporaryRoot "$packageName.zip"
    New-Item -ItemType Directory -Path $pyInstallerWork, $pyInstallerDist, $pyInstallerSpec | Out-Null

    Write-Host "[PalServerConsole] 正在使用 PyInstaller onedir 打包内置 Python runtime..."
    & $venvPython -m PyInstaller `
        --noconfirm `
        --clean `
        --onedir `
        --name "PalServerConsole" `
        --console `
        --icon $appIcon `
        --paths (Join-Path $projectRoot "backend") `
        --add-data "$frontendDist;frontend\dist" `
        --collect-data "palserver_console.metadata" `
        --collect-all "palworld_save_tools" `
        --collect-all "uvicorn" `
        --workpath $pyInstallerWork `
        --distpath $pyInstallerDist `
        --specpath $pyInstallerSpec `
        $portableEntry
    Assert-ExitCode "PyInstaller onedir build"

    $builtProgram = Join-Path $pyInstallerDist "PalServerConsole"
    $builtExecutable = Join-Path $builtProgram "PalServerConsole.exe"
    if (-not (Test-Path -LiteralPath $builtExecutable -PathType Leaf)) {
        throw "PyInstaller did not create the expected executable: $builtExecutable"
    }

    New-Item -ItemType Directory -Path $packageStage | Out-Null
    $portableProgram = Join-Path $packageStage "Program"
    $portableData = Join-Path $packageStage "data"
    $portableMetadata = Join-Path $packageStage "metadata"
    New-Item -ItemType Directory -Path $portableProgram, $portableData, $portableMetadata | Out-Null
    Copy-DirectoryContents $builtProgram $portableProgram

    $portableLauncher = Join-Path $packageStage "PalServerConsole.exe"
    Write-Host "[PalServerConsole] 正在生成根目录 EXE 启动器..."
    $compilerParameters = New-Object System.CodeDom.Compiler.CompilerParameters
    $compilerParameters.CompilerOptions = "/target:exe /platform:x64 /optimize+ /win32icon:`"$appIcon`""
    $compilerParameters.GenerateExecutable = $true
    $compilerParameters.GenerateInMemory = $false
    $compilerParameters.OutputAssembly = $portableLauncher
    $compilerParameters.ReferencedAssemblies.Add("System.dll") | Out-Null
    $compiler = New-Object Microsoft.CSharp.CSharpCodeProvider
    try {
        $compileResult = $compiler.CompileAssemblyFromFile(
            $compilerParameters,
            $portableLauncherSource
        )
    }
    finally {
        $compiler.Dispose()
    }
    $compileErrors = @($compileResult.Errors | Where-Object { -not $_.IsWarning })
    if ($compileErrors.Count -gt 0) {
        $details = ($compileErrors | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
        throw "Portable root launcher compilation failed:`n$details"
    }
    if (-not (Test-Path -LiteralPath $portableLauncher -PathType Leaf)) {
        throw "Portable root launcher was not created: $portableLauncher"
    }

    # Build metadata writes {"status": "unsigned"}; no Authenticode signing claim is made.
    $signing = '{"status": "unsigned"}' | ConvertFrom-Json
    $buildMetadata = [ordered]@{
        formatVersion = 1
        application = "PalServerConsole"
        version = [string]$runtimeMetadata.version
        architecture = "x64"
        python = [ordered]@{
            implementation = "CPython"
            version = [string]$runtime.version
            bits = 64
        }
        database = [ordered]@{
            minimumSchemaVersion = 0
            maximumSchemaVersion = [int]$runtimeMetadata.schemaVersion
        }
        frontend = [ordered]@{
            bundled = $true
            path = "_internal/frontend/dist"
        }
        sourceRevision = $gitRevision
        sourceTreeState = $sourceTreeState
        builtAt = (Get-Date).ToUniversalTime().ToString("o")
        signing = $signing
    }
    $buildMetadataJson = $buildMetadata | ConvertTo-Json -Depth 5
    Set-Content -LiteralPath (Join-Path $portableMetadata "build-info.json") -Value $buildMetadataJson -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $portableProgram "build-info.json") -Value $buildMetadataJson -Encoding UTF8

    $licenses = Join-Path $packageStage "THIRD_PARTY_LICENSES.md"
    & $venvPython $licenseCollector `
        --output $licenses `
        --requirements $runtimeLock `
        --requirements $buildLock `
        --package-lock (Join-Path $frontendRoot "package-lock.json") `
        --node-modules (Join-Path $frontendRoot "node_modules")
    Assert-ExitCode "Third-party license collection"
    Copy-Item -LiteralPath $licenses -Destination (Join-Path $portableProgram "THIRD_PARTY_LICENSES.md")
    Copy-Item -LiteralPath $thirdPartyNotices -Destination $packageStage
    Copy-Item -LiteralPath $projectLicense -Destination $packageStage
    Copy-Item -LiteralPath (Join-Path $projectRoot "docs\windows-portable.md") -Destination (Join-Path $packageStage "README-portable.md")
    Copy-Item -LiteralPath (Join-Path $projectRoot "start-console.bat") -Destination $packageStage
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "upgrade-portable.ps1") -Destination $packageStage
    Copy-Item -LiteralPath $applicationUpdateHelper -Destination $packageStage
    Set-Content -LiteralPath (Join-Path $portableData ".keep") -Value "User data is created here and is never replaced by upgrade-portable.ps1." -Encoding ASCII

    $selfCheckData = Join-Path $temporaryRoot "self-check-data"
    $previousSelfCheckData = $env:PALSERVER_CONSOLE_DATA
    try {
        $env:PALSERVER_CONSOLE_DATA = $selfCheckData
        $selfCheckOutput = & $portableLauncher --portable-self-check
        Assert-ExitCode "Portable root executable self-check"
        $workerSelfCheckOutput = & (Join-Path $portableProgram "PalServerConsole.exe") --world-worker --help
        Assert-ExitCode "Portable worker executable self-check"
    }
    finally {
        if ($null -eq $previousSelfCheckData) {
            Remove-Item Env:\PALSERVER_CONSOLE_DATA -ErrorAction SilentlyContinue
        }
        else {
            $env:PALSERVER_CONSOLE_DATA = $previousSelfCheckData
        }
    }
    $selfCheck = ($selfCheckOutput | Out-String | ConvertFrom-Json)
    if (
        $selfCheck.portableSelfCheck -ne "ok" -or
        $selfCheck.health -ne "ok" -or
        $selfCheck.frontend -ne "ok"
    ) {
        throw "Portable executable self-check returned an unexpected result."
    }
    if (($workerSelfCheckOutput | Out-String) -notmatch "Parse a read-only Palworld snapshot.") {
        throw "Portable worker executable self-check returned unexpected help text."
    }
    $portableDataMarker = Join-Path $portableData ".keep"
    $unexpectedPortableData = @(
        Get-ChildItem -LiteralPath $portableData -Force -Recurse |
            Where-Object {
                -not [string]::Equals(
                    $_.FullName,
                    $portableDataMarker,
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            }
    )
    if ($unexpectedPortableData.Count -gt 0) {
        throw "Portable self-check wrote runtime data into the release package."
    }

    Write-Checksums $packageStage
    Compress-Archive -Path (Join-Path $packageStage "*") -DestinationPath $stagedZipPath -CompressionLevel Optimal
    Move-Item -LiteralPath $packageStage -Destination $packageRoot
    Move-Item -LiteralPath $stagedZipPath -Destination $zipPath
    Write-Host "便携版已生成：$zipPath"
    Write-Host "该包未签名；请同时发布 checksums.sha256，不要宣称已签名。"
}
finally {
    Set-Location -LiteralPath $originalLocation
    if ($null -ne $temporaryRoot -and (Test-Path -LiteralPath $temporaryRoot)) {
        $resolvedTemporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
        $outputPrefix = "$([System.IO.Path]::GetFullPath($outputRoot).TrimEnd([char]'\'))\"
        $temporaryLeaf = Split-Path -Leaf $resolvedTemporaryRoot
        if (
            $resolvedTemporaryRoot.StartsWith(
                $outputPrefix,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -and
            $temporaryLeaf.StartsWith(
                ".opt12-build-",
                [System.StringComparison]::OrdinalIgnoreCase
            )
        ) {
            try {
                Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
            }
            catch {
                Write-Warning "Portable build temporary directory could not be removed: $temporaryRoot"
            }
        }
        else {
            Write-Warning "Refusing to remove unexpected build temporary directory: $temporaryRoot"
        }
    }
}
