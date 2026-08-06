param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$frontendRoot = Join-Path $projectRoot "frontend"
$venvPython = Join-Path $projectRoot ".venv\Scripts\python.exe"

try {
    Set-Location -LiteralPath $projectRoot
    if ([string]::IsNullOrWhiteSpace($env:PALSERVER_CONSOLE_PORT)) {
        $env:PALSERVER_CONSOLE_PORT = "8223"
    }
    Write-Host "[PalServerConsole] 正在检查 Python..."

    if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
        $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
        if ($null -eq $pythonCommand) {
            throw "Python was not found. Install Python 3.11, 3.12, or 3.13 and enable Add Python to PATH."
        }
        $versionOk = & $pythonCommand.Source -c "import sys; raise SystemExit(0 if (3,11) <= sys.version_info[:2] < (3,14) else 1)"
        if ($LASTEXITCODE -ne 0) {
            throw "Unsupported Python version. PalServerConsole requires Python >=3.11,<3.14."
        }
        Write-Host "[PalServerConsole] 首次运行，正在创建 Python venv..."
        & $pythonCommand.Source -m venv (Join-Path $projectRoot ".venv")
        if ($LASTEXITCODE -ne 0) { throw "python -m venv failed with exit code $LASTEXITCODE." }
    }

    & $venvPython -c "import sys; raise SystemExit(0 if (3,11) <= sys.version_info[:2] < (3,14) else 1)"
    if ($LASTEXITCODE -ne 0) {
        throw "Unsupported venv Python version. PalServerConsole requires Python >=3.11,<3.14."
    }

    & $venvPython -c "import importlib.util; raise SystemExit(0 if all(importlib.util.find_spec(name) is not None for name in ('fastapi', 'uvicorn', 'palserver_console')) else 1)"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[PalServerConsole] 正在安装 Python 运行依赖..."
        & $venvPython -m pip install --disable-pip-version-check -e $projectRoot
        if ($LASTEXITCODE -ne 0) { throw "pip install failed with exit code $LASTEXITCODE." }
    }

    $distIndex = Join-Path $frontendRoot "dist\index.html"
    $requiresBuild = -not (Test-Path -LiteralPath $distIndex -PathType Leaf)
    if (-not $requiresBuild) {
        $distTime = (Get-Item -LiteralPath $distIndex).LastWriteTimeUtc
        $latestSource = Get-ChildItem -LiteralPath (Join-Path $frontendRoot "src") -Recurse -File |
            Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
        $packageFiles = @(
            Get-Item -LiteralPath (Join-Path $frontendRoot "package.json")
            Get-Item -LiteralPath (Join-Path $frontendRoot "package-lock.json")
        )
        $requiresBuild = $latestSource.LastWriteTimeUtc -gt $distTime -or
            ($packageFiles | Where-Object { $_.LastWriteTimeUtc -gt $distTime }).Count -gt 0
    }

    if ($requiresBuild) {
        $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if ($null -eq $npmCommand) {
            throw "npm.cmd was not found. Install Node.js LTS and reopen this window."
        }
        Set-Location -LiteralPath $frontendRoot
        Write-Host "[PalServerConsole] 正在按锁文件检查前端构建依赖..."
        & $npmCommand.Source ci
        if ($LASTEXITCODE -ne 0) { throw "npm.cmd ci failed with exit code $LASTEXITCODE." }
        Write-Host "[PalServerConsole] 正在构建前端..."
        & $npmCommand.Source run build
        if ($LASTEXITCODE -ne 0) { throw "npm.cmd run build failed with exit code $LASTEXITCODE." }
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
