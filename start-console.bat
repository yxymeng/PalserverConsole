@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-console.ps1"
if errorlevel 1 (
  echo.
  echo PalServerConsole failed to start. Review the error above.
  pause
)
endlocal
