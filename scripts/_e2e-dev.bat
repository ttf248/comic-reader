@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
node "%~dp0test-e2e.mjs" --keep-server --port 18923
exit /b %errorlevel%
