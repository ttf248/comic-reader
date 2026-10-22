@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
rem Blank lines after UTF-8 messages prevent cmd.exe from skipping subsequent text.
pushd "%~dp0"
if errorlevel 1 exit /b 1

set "result=1"
for %%T in (pwsh.exe go.exe npm.cmd) do (
  where %%T >nul 2>nul
  if errorlevel 1 (
    echo [错误] 找不到 %%T，请安装 PowerShell 7、Go 1.24+、Node.js 20+ 并加入 PATH。

    goto finish
  )
)

rem 使用本机架构，避免继承交叉编译环境后生成无法本机启动的产物。

set "GOARCH="
pwsh -NoProfile -ExecutionPolicy Bypass -File "scripts\build.ps1" -TargetOS windows
set "result=%errorlevel%"
if not "%result%"=="0" (
  echo [错误] 构建失败，请查看上方输出。

  goto finish
)
echo [完成] 已生成 bin\local-gallery.exe 和 frontend\dist。

echo 配置 backend\config.yaml 后，运行 start.bat 启动。


:finish
popd
if /i not "%~1"=="--no-pause" pause
exit /b %result%
