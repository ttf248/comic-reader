@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
pushd "%~dp0.."
if errorlevel 1 exit /b 1
set "TARGET_OS=windows"
set "TARGET_ARCH=amd64"
set "OUTPUT_DIR=bin"
set "VERSION="
set "SKIP_INSTALL=0"
set "SKIP_FRONTEND=0"
set "LOCAL_BUILD=0"
set "PAUSE_ON_EXIT=1"

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--local" (set "LOCAL_BUILD=1"& shift& goto parse)
if /i "%~1"=="--skip-install" (set "SKIP_INSTALL=1"& shift& goto parse)
if /i "%~1"=="--skip-frontend" (set "SKIP_FRONTEND=1"& shift& goto parse)
if /i "%~1"=="--no-pause" (set "PAUSE_ON_EXIT=0"& shift& goto parse)
if /i "%~1"=="--target-os" goto target_os
if /i "%~1"=="--target-arch" goto target_arch
if /i "%~1"=="--output-dir" goto output_dir
if /i "%~1"=="--version" goto version
echo [错误] 未知参数：%~1
set "RESULT=2"
goto finish

:target_os
if "%~2"=="" goto missing_value
set "TARGET_OS=%~2"
shift
shift
goto parse

:target_arch
if "%~2"=="" goto missing_value
set "TARGET_ARCH=%~2"
shift
shift
goto parse

:output_dir
if "%~2"=="" goto missing_value
set "OUTPUT_DIR=%~2"
shift
shift
goto parse

:version
if "%~2"=="" goto missing_value
set "VERSION=%~2"
shift
shift
goto parse

:missing_value
echo [错误] 参数缺少值。
set "RESULT=2"
goto finish

:parsed
if "%LOCAL_BUILD%"=="1" if /i not "%TARGET_OS%"=="windows" goto local_target_error
if "%LOCAL_BUILD%"=="1" for /f "delims=" %%A in ('go env GOHOSTARCH') do set "TARGET_ARCH=%%A"
if /i not "%TARGET_OS%"=="windows" if /i not "%TARGET_OS%"=="linux" if /i not "%TARGET_OS%"=="darwin" goto invalid_os
if /i not "%TARGET_ARCH%"=="amd64" if /i not "%TARGET_ARCH%"=="arm64" goto invalid_arch
where go.exe >nul 2>nul
if errorlevel 1 (echo [错误] 找不到 Go 1.24+，请安装并加入 PATH。& set "RESULT=1"& goto finish)
if "%SKIP_FRONTEND%"=="0" goto frontend
goto backend

:local_target_error
echo [错误] --local 不能与非 Windows 目标组合。
set "RESULT=2"
goto finish

:invalid_os
echo [错误] --target-os 仅支持 windows、linux 或 darwin。
set "RESULT=2"
goto finish

:invalid_arch
echo [错误] --target-arch 仅支持 amd64 或 arm64。
set "RESULT=2"
goto finish

:frontend
if "%SKIP_INSTALL%"=="1" if not exist "frontend\node_modules" (echo [错误] 缺少前端依赖，请运行 scripts\setup-dev.bat。& set "RESULT=1"& goto finish)
pushd frontend
if errorlevel 1 (set "RESULT=1"& goto finish)
if "%SKIP_INSTALL%"=="0" (
  echo [1/2] 安装前端依赖...
  call npm ci
  if errorlevel 1 (popd& set "RESULT=1"& goto failed)
)
if defined VERSION set "LOCAL_GALLERY_VERSION=%VERSION%"
echo [1/2] 构建前端...
call npm run build
set "STEP_RESULT=%errorlevel%"
popd
if not "%STEP_RESULT%"=="0" (set "RESULT=%STEP_RESULT%"& goto failed)

:backend
for %%I in ("%OUTPUT_DIR%") do set "RESOLVED_OUTPUT=%%~fI"
if not exist "%RESOLVED_OUTPUT%" mkdir "%RESOLVED_OUTPUT%"
if not exist "%RESOLVED_OUTPUT%" (set "RESULT=1"& goto failed)
if /i "%TARGET_OS%"=="windows" (set "BINARY=local-gallery.exe") else (set "BINARY=local-gallery")
set "GOOS=%TARGET_OS%"
set "GOARCH=%TARGET_ARCH%"
set "CGO_ENABLED=0"
set "LDFLAGS="
if defined VERSION set "LDFLAGS=-X github.com/tianlongxiang/local-gallery/internal/config.Version=%VERSION%"
echo [2/2] 编译 %TARGET_OS%/%TARGET_ARCH%...
pushd backend
if errorlevel 1 (set "RESULT=1"& goto finish)
go build -ldflags "%LDFLAGS%" -o "%RESOLVED_OUTPUT%\%BINARY%" .\cmd\server
set "RESULT=%errorlevel%"
popd
if not "%RESULT%"=="0" goto failed
echo [完成] 已生成 %RESOLVED_OUTPUT%\%BINARY%。
set "RESULT=0"
goto finish

:failed
if not defined RESULT set "RESULT=1"
echo [错误] 构建失败，请查看上方输出。

:finish
popd
if not defined RESULT set "RESULT=1"
if "%PAUSE_ON_EXIT%"=="1" pause
exit /b %RESULT%
