@echo off
setlocal DisableDelayedExpansion
if "%~1"=="" goto usage
set "COMMIT_SHA=%~1"
set "REPOSITORY=%~2"
if not defined REPOSITORY set "REPOSITORY=ttf248/local-gallery"
where gh.exe >nul 2>nul
if errorlevel 1 (echo [错误] 监控 Actions 需要 GitHub CLI（gh）。& exit /b 1)
echo 正在等待 %REPOSITORY% 中提交 %COMMIT_SHA% 的工作流...
set /a ELAPSED=0
:poll
set "FOUND_RUN=0"
set "FAILED_RUN=0"
for /f "usebackq delims=" %%R in (`gh run list --repo "%REPOSITORY%" --commit "%COMMIT_SHA%" --limit 100 --json databaseId --jq ".[].databaseId"`) do call :watch "%%R"
if "%FOUND_RUN%"=="1" (
  if "%FAILED_RUN%"=="1" exit /b 1
  exit /b 0
)
timeout /t 15 /nobreak >nul
set /a ELAPSED+=15
if %ELAPSED% GEQ 900 (echo [错误] 等待 Actions 超时。& exit /b 1)
goto poll

:watch
set "FOUND_RUN=1"
gh run watch %~1 --repo "%REPOSITORY%" --exit-status
if errorlevel 1 set "FAILED_RUN=1"
exit /b 0

:usage
echo 用法：scripts\watch-github-actions.bat 提交 SHA [owner/repo]
exit /b 2

\n