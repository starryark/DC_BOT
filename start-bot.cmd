@echo off
setlocal
cd /d "%~dp0"
call pnpm start
exit /b %errorlevel%
