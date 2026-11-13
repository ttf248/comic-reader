@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
pushd "%~dp0.."
if errorlevel 1 exit /b 1
if "%~1"=="" goto usage
if "%~2"=="" goto usage
if "%~3"=="" goto usage
set "VERSION=%~1"
set "TARGET_OS=%~2"
set "TARGET_ARCH=%~3"
set "OUTPUT_DIR=%~4"
if not defined OUTPUT_DIR set "OUTPUT_DIR=artifacts"
set "SKIP_FRONTEND=0"
if /i "%~5"=="--skip-frontend" set "SKIP_FRONTEND=1"
node -e "process.exit(/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(process.argv[1]) ? 0 : 1)" "%VERSION%"
if errorlevel 1 (echo [错误] 版本需使用不带 v 的 SemVer，例如 2.0.0。& goto failed)
for %%I in ("%OUTPUT_DIR%") do set "OUTPUT_DIR=%%~fI"
set "WORK_DIR=%TEMP%\local-gallery-package-%RANDOM%-%RANDOM%"
set "PACKAGE_NAME=local-gallery-v%VERSION%-%TARGET_OS%-%TARGET_ARCH%"
mkdir "%WORK_DIR%\bin" >nul 2>nul
if errorlevel 1 (echo [错误] 创建临时目录失败。& goto cleanup_failed)
if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%" >nul 2>nul
if not exist "%OUTPUT_DIR%" (echo [错误] 创建输出目录失败。& goto cleanup_failed)

:build
if "%SKIP_FRONTEND%"=="1" goto build_no_frontend
call scripts\build.bat --target-os "%TARGET_OS%" --target-arch "%TARGET_ARCH%" --output-dir "%WORK_DIR%\bin" --version "%VERSION%" --skip-install --no-pause
goto build_done
:build_no_frontend
call scripts\build.bat --target-os "%TARGET_OS%" --target-arch "%TARGET_ARCH%" --output-dir "%WORK_DIR%\bin" --version "%VERSION%" --skip-install --skip-frontend --no-pause
:build_done
if errorlevel 1 goto cleanup_failed
if /i "%TARGET_OS%"=="windows" (set "BINARY=local-gallery.exe") else (set "BINARY=local-gallery")
if not exist "%WORK_DIR%\bin\%BINARY%" (echo [错误] 缺少后端构建产物。& goto cleanup_failed)
if not exist "frontend\dist\index.html" (echo [错误] 缺少 frontend\dist\index.html。& goto cleanup_failed)

set "PACKAGE_DIR=%WORK_DIR%\%PACKAGE_NAME%"
mkdir "%PACKAGE_DIR%\dist" "%PACKAGE_DIR%\backend" "%PACKAGE_DIR%\aiworker" >nul 2>nul
copy /y "%WORK_DIR%\bin\%BINARY%" "%PACKAGE_DIR%\%BINARY%" >nul
if errorlevel 1 goto cleanup_failed
xcopy "frontend\dist\*" "%PACKAGE_DIR%\dist\" /e /i /q /y >nul
if errorlevel 2 goto cleanup_failed
copy /y "backend\config.example.yaml" "%PACKAGE_DIR%\config.example.yaml" >nul
copy /y "backend\config.example.yaml" "%PACKAGE_DIR%\backend\config.example.yaml" >nul
xcopy "docs" "%PACKAGE_DIR%\docs\" /e /i /q /y >nul
if errorlevel 2 goto cleanup_failed
xcopy "backend\aiworker\*.py" "%PACKAGE_DIR%\aiworker\" /i /q /y >nul
if errorlevel 2 goto cleanup_failed
xcopy "backend\aiworker\*.txt" "%PACKAGE_DIR%\aiworker\" /i /q /y >nul
if errorlevel 2 goto cleanup_failed
copy /y "backend\aiworker\*.bat" "%PACKAGE_DIR%\aiworker\" >nul
copy /y README.md AGENTS.md "%PACKAGE_DIR%\" >nul
if exist LICENSE copy /y LICENSE "%PACKAGE_DIR%\LICENSE" >nul

if /i "%TARGET_OS%"=="windows" (
  tar.exe -a -c -f "%OUTPUT_DIR%\%PACKAGE_NAME%.zip" -C "%WORK_DIR%" "%PACKAGE_NAME%"
) else (
  tar.exe -czf "%OUTPUT_DIR%\%PACKAGE_NAME%.tar.gz" -C "%WORK_DIR%" "%PACKAGE_NAME%"
)
if errorlevel 1 goto cleanup_failed
echo [完成] 发布包位于 %OUTPUT_DIR%\%PACKAGE_NAME%
rmdir /s /q "%WORK_DIR%"
popd
exit /b 0

:usage
echo 用法：scripts\package-release.bat 版本 目标系统 目标架构 [输出目录] [--skip-frontend]
echo 示例：scripts\package-release.bat 2.0.0 windows amd64
set "RESULT=2"
goto finish
:cleanup_failed
if defined WORK_DIR if exist "%WORK_DIR%" rmdir /s /q "%WORK_DIR%"
:failed
set "RESULT=1"
echo [错误] 发布包生成失败。
:finish
popd
exit /b %RESULT%
