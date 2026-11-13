@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
set "http_proxy=http://127.0.0.1:7897"
set "https_proxy=http://127.0.0.1:7897"
set "HTTP_PROXY=http://127.0.0.1:7897"
set "HTTPS_PROXY=http://127.0.0.1:7897"
set "PYTHON=%~dp0.venv\Scripts\python.exe"
if not exist "%PYTHON%" (
  echo [错误] 未找到项目 Python 环境，请先运行 setup.bat。
  exit /b 1
)
"%PYTHON%" "%~dp0download_models.py"
exit /b %errorlevel%
