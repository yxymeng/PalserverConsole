@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0PalServerConsole.exe" (
  "%~dp0PalServerConsole.exe" %*
) else if exist "%~dp0Program\PalServerConsole.exe" (
  set "PALSERVER_CONSOLE_DATA=%~dp0data"
  "%~dp0Program\PalServerConsole.exe" %*
) else (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-console.ps1"
)
if errorlevel 1 (
  echo.
  echo PalServerConsole failed to start. Review the error above.
  pause
)
endlocal
