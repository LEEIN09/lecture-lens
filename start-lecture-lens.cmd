@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo [Lecture Lens] First-time setup is required.
  call npm.cmd install
)
call npm.cmd start
