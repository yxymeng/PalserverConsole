[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$WaitPid,
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,
    [Parameter(Mandatory = $true)]
    [string]$DataDirectory,
    [Parameter(Mandatory = $true)]
    [string]$NewPackage,
    [Parameter(Mandatory = $true)]
    [string]$InstanceId,
    [Parameter(Mandatory = $true)]
    [int]$Port
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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

function Start-ConsoleLauncher {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Launcher,
        [Parameter(Mandatory = $true)][string]$InstallRootPath,
        [Parameter(Mandatory = $true)][string]$InstanceId,
        [Parameter(Mandatory = $true)][int]$Port
    )

    if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf)) {
        throw "UPDATE_RELAUNCH_FAILED: PalServerConsole.exe is missing."
    }
    $arguments = @("-InstanceId", $InstanceId, "-Port", [string]$Port)
    Start-Process -FilePath $Launcher -ArgumentList $arguments -WorkingDirectory $InstallRootPath -WindowStyle Hidden
}

function Restore-ConsoleLauncher {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Launcher,
        [Parameter(Mandatory = $true)][string]$InstallRootPath,
        [Parameter(Mandatory = $true)][string]$InstanceId,
        [Parameter(Mandatory = $true)][int]$Port
    )

    if (@(Get-CurrentInstallConsoleProcesses -InstallRootPath $InstallRootPath).Count -gt 0) {
        return
    }
    try {
        Start-ConsoleLauncher -Launcher $Launcher -InstallRootPath $InstallRootPath -InstanceId $InstanceId -Port $Port
    }
    catch {
        throw "UPDATE_FAILURE_RELAUNCH_FAILED: $($_.Exception.Message)"
    }
}

$installRootPath = [System.IO.Path]::GetFullPath($InstallRoot)
$dataDirectoryPath = [System.IO.Path]::GetFullPath($DataDirectory)
$packageRootPath = [System.IO.Path]::GetFullPath($NewPackage)
$upgradeScript = Join-Path $packageRootPath "upgrade-portable.ps1"
$launcher = Join-Path $installRootPath "PalServerConsole.exe"
$updateLockPath = Join-Path $installRootPath ".palserver-console-update.lock"
$logDirectory = Join-Path $dataDirectoryPath "application-updates"
$logPath = Join-Path $logDirectory "apply-update.log"
$exitCode = 0

try {
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $deadline = [DateTime]::UtcNow.AddMinutes(2)
    while (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) {
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "CONSOLE_EXIT_TIMEOUT: PalServerConsole did not exit within 120 seconds."
        }
        Start-Sleep -Milliseconds 500
    }
    while ($true) {
        $currentInstallProcesses = @(
            Get-CurrentInstallConsoleProcesses -InstallRootPath $installRootPath
        )
        if ($currentInstallProcesses.Count -eq 0) {
            break
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "CONSOLE_EXIT_TIMEOUT: PalServerConsole processes for this installation did not exit within 120 seconds."
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-Path -LiteralPath $upgradeScript -PathType Leaf)) {
        throw "UPDATE_HELPER_INVALID: upgrade-portable.ps1 is missing from the downloaded package."
    }

    & $upgradeScript `
        -NewPackage $packageRootPath `
        -InstallRoot $installRootPath `
        -DataDirectory $dataDirectoryPath *>&1 |
        Out-File -LiteralPath $logPath -Encoding utf8
    if (-not $?) {
        throw "UPDATE_APPLY_FAILED: upgrade-portable.ps1 returned a failure."
    }
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        throw "UPDATE_RELAUNCH_FAILED: upgraded PalServerConsole.exe is missing."
    }

    Start-ConsoleLauncher -Launcher $launcher -InstallRootPath $installRootPath -InstanceId $InstanceId -Port $Port
}
catch {
    $updateError = $_
    $updateError | Out-File -LiteralPath $logPath -Append -Encoding utf8
    try {
        Restore-ConsoleLauncher -Launcher $launcher -InstallRootPath $installRootPath -InstanceId $InstanceId -Port $Port
    }
    catch {
        $_ | Out-File -LiteralPath $logPath -Append -Encoding utf8
    }
    $exitCode = 1
}
finally {
    Remove-Item -LiteralPath $updateLockPath -Force -ErrorAction SilentlyContinue
}

exit $exitCode
