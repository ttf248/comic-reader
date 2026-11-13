@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
pushd "%~dp0"
if errorlevel 1 exit /b 1

set "http_proxy=http://127.0.0.1:7897"
set "https_proxy=http://127.0.0.1:7897"
set "HTTP_PROXY=http://127.0.0.1:7897"
set "HTTPS_PROXY=http://127.0.0.1:7897"
set "PIP_DEFAULT_TIMEOUT=120"
echo 下载默认使用代理：http_proxy=%http_proxy%
where py.exe >nul 2>nul
if errorlevel 1 (echo [错误] 找不到 Python Launcher。请安装 Python 3.11 并启用 py.exe。& goto failed)
py -3.11 --version >nul 2>nul
if errorlevel 1 (echo [错误] 未找到 Python 3.11。& goto failed)

set "PYTHON=%CD%\.venv\Scripts\python.exe"
if not exist "%PYTHON%" (
  echo 正在创建 .venv...
  py -3.11 -m venv .venv
  if errorlevel 1 (echo [错误] 创建 Python 虚拟环境失败。& goto failed)
)
"%PYTHON%" -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)"
if errorlevel 1 (echo [错误] .venv 必须使用 Python 3.11；请删除 backend\aiworker\.venv 后重试。& goto failed)

echo 正在更新 pip...
"%PYTHON%" -m pip install --upgrade pip
if errorlevel 1 (echo [错误] 更新 pip 失败。& goto failed)

"%PYTHON%" -c "import torch, torchvision; raise SystemExit(0 if torch.__version__.startswith('2.7.1') and torchvision.__version__.startswith('0.22.1') and torch.version.cuda and torch.version.cuda.startswith('12.6') else 1)" >nul 2>nul
if errorlevel 1 (
  echo 正在安装 CUDA 12.6 版 PyTorch...
  "%PYTHON%" -m pip install torch==2.7.1 torchvision==0.22.1 --index-url https://download.pytorch.org/whl/cu126
  if errorlevel 1 (echo [错误] 安装 PyTorch 失败，请检查代理与网络。& goto failed)
)

echo 正在安装 Chinese-CLIP...
"%PYTHON%" -m pip install --no-deps cn_clip==1.6.0
if errorlevel 1 (echo [错误] 安装 Chinese-CLIP 失败。& goto failed)
"%PYTHON%" -c "import importlib.metadata as m; m.version('onnxruntime')" >nul 2>nul
if not errorlevel 1 (
  echo 正在移除冲突的 CPU 版 ONNX Runtime...
  "%PYTHON%" -m pip uninstall -y onnxruntime
  if errorlevel 1 (echo [错误] 移除冲突的 ONNX Runtime 失败。& goto failed)
)
echo 正在安装 OCR 与人脸识别依赖...
"%PYTHON%" -m pip install -r requirements.txt
if errorlevel 1 (echo [错误] 安装 OCR 与人脸识别依赖失败。& goto failed)

echo 正在下载并校验模型...
call download-model.bat
if errorlevel 1 goto failed
for /f "delims=" %%D in ('call "%PYTHON%" model_cache.py') do set "MODEL_DIR=%%D"
if not defined MODEL_DIR (echo [错误] 读取模型目录失败。& goto failed)

echo 正在验证 OCR 与人脸推理...
"%PYTHON%" worker.py "%MODEL_DIR%" --verify-install
if errorlevel 1 (echo [错误] OCR / 人脸推理验证失败。& goto failed)
"%PYTHON%" -c "import subprocess,sys; p=subprocess.run([sys.executable,'-m','pip','check'],capture_output=True,text=True); lines=[x for x in (p.stdout+p.stderr).splitlines() if x and not x.startswith('cn-clip 1.6.0 requires lmdb')]; print('\n'.join(lines)); sys.exit(bool(lines))"
if errorlevel 1 (echo [错误] Python 依赖检查发现冲突。& goto failed)
echo [完成] Python 环境、OCR、人脸识别和模型均已就绪。
echo 环境：%CD%\.venv
echo 模型：%MODEL_DIR%
popd
exit /b 0

:failed
set "RESULT=%errorlevel%"
if "%RESULT%"=="0" set "RESULT=1"
popd
echo [失败] AI 环境初始化未完成。
pause
exit /b %RESULT%
