@echo off
setlocal
cd /d "%~dp0" || exit /b 1
if not exist node_modules\.bin\expo.cmd (
  call npm.cmd ci || goto :failed
)
call node_modules\.bin\expo.cmd whoami >nul 2>&1
if errorlevel 1 (
  echo Open the complete Expo login link printed below in your signed-in browser on this PC.
  echo Keep this window open until the QR code appears.
  setlocal
  set "BROWSER=none"
  call node_modules\.bin\expo.cmd login --browser || goto :failed
  endlocal
)
echo Connect the iPhone and PC to the same local network. Scan the QR code with the iPhone camera.
call npm.cmd start
if errorlevel 1 goto :failed
exit /b 0

:failed
echo ScottyGo preview could not start. Review the message above.
pause
exit /b 1
