@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
pushd "%~dp0.."
if errorlevel 1 exit /b 1
set "URL=https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
set "TARGET=bin\ffmpeg\windows\amd64"
set "FORCE=0"

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--force" (set "FORCE=1"& shift& goto parse)
if /i "%~1"=="--url" goto url
if /i "%~1"=="--target-dir" goto target
echo [错误] 未知参数：%~1
goto failed
:url
if "%~2"=="" goto failed
set "URL=%~2"
shift
shift
goto parse
:target
if "%~2"=="" goto failed
set "TARGET=%~2"
shift
shift
goto parse

:parsed
for %%I in ("%TARGET%") do set "TARGET=%%~fI"
if "%FORCE%"=="0" if exist "%TARGET%\ffmpeg.exe" if exist "%TARGET%\ffprobe.exe" (
  "%TARGET%\ffmpeg.exe" -version 2>nul | findstr /b /c:"ffmpeg version" >nul
  if not errorlevel 1 (echo [已就绪] %TARGET%& popd& exit /b 0)
)
where curl.exe >nul 2>nul
if errorlevel 1 (echo [错误] 找不到 curl.exe。& goto failed)
where tar.exe >nul 2>nul
if errorlevel 1 (echo [错误] 找不到 tar.exe。& goto failed)
set "TEMP_ROOT=%TEMP%\local-gallery-ffmpeg-%RANDOM%-%RANDOM%"
mkdir "%TEMP_ROOT%\extract" >nul 2>nul
if errorlevel 1 (echo [错误] 创建临时目录失败。& goto failed)
echo 正在下载 FFmpeg...
curl.exe --location --fail --show-error --retry 3 --output "%TEMP_ROOT%\ffmpeg.zip" "%URL%"
if errorlevel 1 goto cleanup_failed
echo 正在解压...
tar.exe -xf "%TEMP_ROOT%\ffmpeg.zip" -C "%TEMP_ROOT%\extract"
if errorlevel 1 goto cleanup_failed
for /r "%TEMP_ROOT%\extract" %%F in (ffmpeg.exe) do if not defined FFMPEG_BIN set "FFMPEG_BIN=%%~dpF"
if not defined FFMPEG_BIN (echo [错误] 压缩包中未找到 ffmpeg.exe。& goto cleanup_failed)
if not exist "%TARGET%" mkdir "%TARGET%"
if errorlevel 1 goto cleanup_failed
copy /y "%FFMPEG_BIN%ffmpeg.exe" "%TARGET%\ffmpeg.exe" >nul
if errorlevel 1 goto cleanup_failed
copy /y "%FFMPEG_BIN%ffprobe.exe" "%TARGET%\ffprobe.exe" >nul
if errorlevel 1 goto cleanup_failed
"%TARGET%\ffmpeg.exe" -version 2>nul | findstr /b /c:"ffmpeg version" >nul
if errorlevel 1 (echo [错误] ffmpeg 自检失败。& goto cleanup_failed)
"%TARGET%\ffprobe.exe" -version 2>nul | findstr /b /c:"ffprobe version" >nul
if errorlevel 1 (echo [错误] ffprobe 自检失败。& goto cleanup_failed)
rmdir /s /q "%TEMP_ROOT%"
echo [完成] FFmpeg 已安装到 %TARGET%
popd
exit /b 0

:cleanup_failed
if defined TEMP_ROOT rmdir /s /q "%TEMP_ROOT%" >nul 2>nul
:failed
popd
echo [失败] FFmpeg 安装失败。
exit /b 1
