param(
    [string]$InstanceId = "",
    [int]$Port = 0
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$frontendRoot = Join-Path $projectRoot "frontend"
$venvPython = Join-Path $projectRoot ".venv\Scripts\python.exe"
$pythonLock = Join-Path $projectRoot "requirements.lock"
$pythonDependencyStamp = Join-Path $projectRoot ".venv\.palserver-console-python-lock.sha256"
$frontendLock = Join-Path $frontendRoot "package-lock.json"
$frontendDependencyStamp = Join-Path $frontendRoot "node_modules\.palserver-console-package-lock.sha256"
$frontendBuildInputStamp = Join-Path $frontendRoot "dist\.palserver-console-build-inputs.sha256"

try {
    Set-Location -LiteralPath $projectRoot
    if ([string]::IsNullOrWhiteSpace($InstanceId)) {
        if ($Port -ne 0) {
            throw "-Port requires -InstanceId. Use the default launcher without parameters for the default instance."
        }
        if ([string]::IsNullOrWhiteSpace($env:PALSERVER_CONSOLE_PORT)) {
            $env:PALSERVER_CONSOLE_PORT = "8223"
        }
    } else {
        if ($InstanceId -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') {
            throw "-InstanceId must contain 1-64 letters, digits, '-' or '_', and must not start with punctuation."
        }
        if ($Port -lt 1 -or $Port -gt 65535) {
            throw "A named instance requires -Port between 1 and 65535."
        }
        $env:PALSERVER_CONSOLE_INSTANCE = $InstanceId
        $env:PALSERVER_CONSOLE_PORT = $Port.ToString()
    }
    Write-Host "[PalServerConsole] 正在检查 Python..."

    if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
        $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
        if ($null -eq $pythonCommand) {
            throw "Python was not found. Install 64-bit CPython 3.13 and enable Add Python to PATH."
        }
        $versionOk = & $pythonCommand.Source -c "import platform, struct, sys; raise SystemExit(0 if sys.version_info[:2] == (3,13) and platform.python_implementation() == 'CPython' and struct.calcsize('P') == 8 else 1)"
        if ($LASTEXITCODE -ne 0) {
            throw "Unsupported Python runtime. PalServerConsole source builds require 64-bit CPython 3.13."
        }
        Write-Host "[PalServerConsole] 首次运行，正在创建 Python venv..."
        & $pythonCommand.Source -m venv (Join-Path $projectRoot ".venv")
        if ($LASTEXITCODE -ne 0) { throw "python -m venv failed with exit code $LASTEXITCODE." }
    }

    & $venvPython -c "import platform, struct, sys; raise SystemExit(0 if sys.version_info[:2] == (3,13) and platform.python_implementation() == 'CPython' and struct.calcsize('P') == 8 else 1)"
    if ($LASTEXITCODE -ne 0) {
        throw "Unsupported venv Python runtime. PalServerConsole source builds require 64-bit CPython 3.13."
    }

    if (-not (Test-Path -LiteralPath $pythonLock -PathType Leaf)) {
        throw "Python dependency lock is missing: $pythonLock"
    }
    $pythonLockHash = (Get-FileHash -LiteralPath $pythonLock -Algorithm SHA256).Hash
    $expectedModule = (Resolve-Path -LiteralPath (Join-Path $projectRoot "backend\palserver_console\__init__.py")).Path
    $pythonDependenciesReady = $false
    if (Test-Path -LiteralPath $pythonDependencyStamp -PathType Leaf) {
        $installedPythonLockHash = (Get-Content -LiteralPath $pythonDependencyStamp -Raw).Trim()
        if ($installedPythonLockHash -eq $pythonLockHash) {
            $resolvedModule = (& $venvPython -c "import fastapi, palserver_console, palworld_save_tools, psutil, uvicorn; print(palserver_console.__file__)").Trim()
            if ($LASTEXITCODE -eq 0) {
                $resolvedModule = [System.IO.Path]::GetFullPath($resolvedModule)
                $pythonDependenciesReady = [System.String]::Equals(
                    $resolvedModule,
                    $expectedModule,
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            }
        }
    }
    if (-not $pythonDependenciesReady) {
        Write-Host "[PalServerConsole] 正在按 Python 锁文件安装运行依赖..."
        & $venvPython -m pip install --disable-pip-version-check --require-hashes -r $pythonLock
        if ($LASTEXITCODE -ne 0) { throw "pip install --require-hashes failed with exit code $LASTEXITCODE." }
        & $venvPython -m pip install --disable-pip-version-check --no-deps --no-build-isolation -e $projectRoot
        if ($LASTEXITCODE -ne 0) { throw "pip install -e failed with exit code $LASTEXITCODE." }
        Set-Content -LiteralPath $pythonDependencyStamp -Value $pythonLockHash -NoNewline -Encoding ascii
    }

    if (-not (Test-Path -LiteralPath $frontendLock -PathType Leaf)) {
        throw "Frontend dependency lock is missing: $frontendLock"
    }
    $frontendLockHash = (Get-FileHash -LiteralPath $frontendLock -Algorithm SHA256).Hash
    $frontendDependenciesChanged = $true
    if (Test-Path -LiteralPath $frontendDependencyStamp -PathType Leaf) {
        $installedFrontendLockHash = (Get-Content -LiteralPath $frontendDependencyStamp -Raw).Trim()
        $frontendDependenciesChanged = $installedFrontendLockHash -ne $frontendLockHash
    }
    $npmCommand = $null
    if ($frontendDependenciesChanged) {
        $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if ($null -eq $npmCommand) {
            throw "npm.cmd was not found. Install Node.js LTS and reopen this window."
        }
        Set-Location -LiteralPath $frontendRoot
        Write-Host "[PalServerConsole] 正在按锁文件检查前端构建依赖..."
        & $npmCommand.Source ci
        if ($LASTEXITCODE -ne 0) { throw "npm.cmd ci failed with exit code $LASTEXITCODE." }
        Set-Content -LiteralPath $frontendDependencyStamp -Value $frontendLockHash -NoNewline -Encoding ascii
    }

    $frontendBuildInputPaths = @(
        (Join-Path $projectRoot "backend\palserver_console\__init__.py")
        (Join-Path $frontendRoot "index.html")
        (Join-Path $frontendRoot "package.json")
        (Join-Path $frontendRoot "package-lock.json")
        (Join-Path $frontendRoot "vite.config.ts")
        (Join-Path $frontendRoot "tsconfig.json")
        (Join-Path $frontendRoot "tsconfig.app.json")
        (Join-Path $frontendRoot "tsconfig.node.json")
    )
    $frontendBuildInputFiles = @(
        Get-ChildItem -LiteralPath (Join-Path $frontendRoot "src") -Recurse -File
        Get-Item -LiteralPath $frontendBuildInputPaths
    ) | Sort-Object -Property FullName
    $frontendBuildFingerprint = ($frontendBuildInputFiles | ForEach-Object {
        $relativePath = $_.FullName.Substring($projectRoot.Length).TrimStart([char[]]"\/")
        $fileHash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
        "$relativePath=$fileHash"
    }) -join "`n"

    $distIndex = Join-Path $frontendRoot "dist\index.html"
    $requiresBuild = $frontendDependenciesChanged -or
        -not (Test-Path -LiteralPath $distIndex -PathType Leaf) -or
        -not (Test-Path -LiteralPath $frontendBuildInputStamp -PathType Leaf)
    if (-not $requiresBuild) {
        $installedBuildFingerprint = (Get-Content -LiteralPath $frontendBuildInputStamp -Raw).Trim()
        $requiresBuild = $installedBuildFingerprint -ne $frontendBuildFingerprint
    }

    if ($requiresBuild) {
        if ($null -eq $npmCommand) {
            $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
        }
        if ($null -eq $npmCommand) {
            throw "npm.cmd was not found. Install Node.js LTS and reopen this window."
        }
        Set-Location -LiteralPath $frontendRoot
        Write-Host "[PalServerConsole] 正在构建前端..."
        & $npmCommand.Source run build
        if ($LASTEXITCODE -ne 0) { throw "npm.cmd run build failed with exit code $LASTEXITCODE." }
        Set-Content -LiteralPath $frontendBuildInputStamp -Value $frontendBuildFingerprint -NoNewline -Encoding ascii
    }

    Set-Location -LiteralPath $projectRoot
    $expectedModule = (Resolve-Path -LiteralPath (Join-Path $projectRoot "backend\palserver_console\__init__.py")).Path
    $resolvedModule = (& $venvPython -c "import palserver_console; print(palserver_console.__file__)").Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to resolve the PalServerConsole Python module."
    }
    $resolvedModule = [System.IO.Path]::GetFullPath($resolvedModule)
    if (-not [System.String]::Equals(
        $resolvedModule,
        $expectedModule,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Unexpected palserver_console module. Expected: $expectedModule Actual: $resolvedModule"
    }

    Write-Host "[PalServerConsole] 正在启动本项目，浏览器将在服务就绪后打开本地页面。"
    & $venvPython -m palserver_console
    if ($LASTEXITCODE -ne 0) { throw "PalServerConsole exited with code $LASTEXITCODE." }
}
catch {
    Write-Host ""
    Write-Host "启动失败。请保留下面的英文错误信息：" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Read-Host "按 Enter 键关闭窗口"
    exit 1
}
