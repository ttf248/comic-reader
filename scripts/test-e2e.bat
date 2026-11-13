@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
where node.exe >nul 2>nul
if errorlevel 1 (echo [错误] 端到端验证需要 Node.js 20+。& exit /b 1)
node "%~dp0test-e2e.mjs" %*
exit /b %errorlevel%
