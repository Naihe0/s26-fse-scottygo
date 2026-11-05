@echo off
setlocal
cd /d "%~dp0" || exit /b 1
if not exist node_modules\.bin\expo.cmd (
  call npm.cmd ci || goto :failed
)
call node_modules\.bin\expo.cmd whoami >nul 2>&1
if errorlevel 1 (
  echo Sign in to Expo in your browser. Use the same Expo account in Expo Go on your iPhone.
  call node_modules\.bin\expo.cmd login --browser || goto :failed
)
echo Connect the iPhone and PC to the same local network. Scan the QR code with the iPhone camera.
call npm.cmd start
if errorlevel 1 goto :failed
exit /b 0

:failed
echo ScottyGo preview could not start. Review the message above.
pause
exit /b 1
