@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
pushd "%~dp0.."
if errorlevel 1 exit /b 1
for %%T in (go.exe node.exe npm.cmd) do (
  where %%T >nul 2>nul
  if errorlevel 1 (
    echo [错误] 缺少 %%T。请安装 Go 1.24+ 和 Node.js 20+，再重新打开终端。
    popd
    exit /b 1
  )
)
for /f "tokens=3" %%V in ('go version') do set "GO_VERSION=%%V"
for /f "tokens=2 delims=." %%V in ("%GO_VERSION%") do set "GO_MINOR=%%V"
if %GO_MINOR% LSS 24 (echo [错误] 需要 Go 1.24 或更新版本，当前为 %GO_VERSION%。& popd& exit /b 1)
echo %GO_VERSION%
node --version
npm --version
if not exist "backend\config.yaml" copy /y "backend\config.example.yaml" "backend\config.yaml" >nul
if errorlevel 1 (echo [错误] 创建 backend\config.yaml 失败。& popd& exit /b 1)
echo 正在准备 Go 依赖...
pushd backend
go mod download
set "RESULT=%errorlevel%"
popd
if not "%RESULT%"=="0" (popd& exit /b %RESULT%)
echo 正在准备前端依赖...
pushd frontend
call npm ci
set "RESULT=%errorlevel%"
popd
if not "%RESULT%"=="0" (popd& exit /b %RESULT%)
echo [完成] 开发依赖已准备。请编辑 backend\config.yaml 设置媒体目录。
popd
exit /b 0
