@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
rem Blank lines after UTF-8 messages prevent cmd.exe from skipping subsequent text.
pushd "%~dp0backend"
if errorlevel 1 exit /b 1

set "result=1"
if not exist "..\bin\local-gallery.exe" (
  echo [错误] 缺少 bin\local-gallery.exe，请先运行 build.bat。

  goto finish
)
if not exist "..\frontend\dist\index.html" (
  echo [错误] 缺少 frontend\dist\index.html，请先运行 build.bat。

  goto finish
)
if not exist "config.yaml" (
  echo [错误] 缺少 backend\config.yaml。

  echo 请复制 backend\config.example.yaml 为 backend\config.yaml，设置 mediaRoots，

  echo 并将 staticDir 设置为 "../frontend/dist"，然后重新运行 start.bat。

  goto finish
)

echo 正在运行已构建的服务，按 Ctrl+C 停止。

echo 浏览器访问配置的 host 和 port；默认地址为 http://127.0.0.1:8080。

"..\bin\local-gallery.exe" --config "config.yaml"
set "result=%errorlevel%"
if not "%result%"=="0" echo [错误] 服务退出，请查看上方输出。


:finish
popd
if not "%result%"=="0" if /i not "%~1"=="--no-pause" pause
exit /b %result%
