@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
pushd "%~dp0.."
if errorlevel 1 exit /b 1
if "%~1"=="" goto usage
set "MESSAGE_FILE=%~1"
set "REMOTE=%~2"
if not defined REMOTE set "REMOTE=origin"
set "BRANCH=%~3"
set "SKIP_VALIDATION=0"
if /i "%~4"=="--skip-validation" set "SKIP_VALIDATION=1"
if not exist "%MESSAGE_FILE%" (echo [错误] 找不到提交说明文件：%MESSAGE_FILE%& goto failed)
for /f "delims=" %%B in ('git branch --show-current') do set "BRANCH_CURRENT=%%B"
if not defined BRANCH_CURRENT (echo [错误] 当前处于 detached HEAD。& goto failed)
if not defined BRANCH set "BRANCH=%BRANCH_CURRENT%"
git diff --cached --quiet
if not errorlevel 1 (echo [错误] 暂存区没有改动。& goto failed)
git diff --cached --check
if errorlevel 1 goto failed

if "%SKIP_VALIDATION%"=="1" goto commit
echo [1/4] 构建前后端...
call scripts\build.bat --no-pause
if errorlevel 1 goto failed
echo [2/4] 运行后端测试...
pushd backend
go test ./...
set "RESULT=%errorlevel%"
popd
if not "%RESULT%"=="0" goto failed
echo [3/4] 运行前端检查与测试...
pushd frontend
call npm run lint
if errorlevel 1 (popd& goto failed)
call npm run test
set "RESULT=%errorlevel%"
popd
if not "%RESULT%"=="0" goto failed

:commit
echo [4/4] 提交并推送已暂存文件...
git commit --file "%MESSAGE_FILE%"
if errorlevel 1 goto failed
git push "%REMOTE%" "HEAD:%BRANCH%"
if errorlevel 1 goto failed
echo [完成] 已推送到 %REMOTE%/%BRANCH%。CI 需在 GitHub Actions 页面手动运行。
popd
exit /b 0

:usage
echo 用法：scripts\publish.bat 提交说明文件 [远端] [分支] [--skip-validation]
set "RESULT=2"
goto finish
:failed
set "RESULT=1"
echo [错误] 提交或推送失败；本地提交（若已创建）会保留。
:finish
popd
exit /b %RESULT%
