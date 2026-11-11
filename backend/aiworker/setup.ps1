$ErrorActionPreference = "Stop"

$workerDir = $PSScriptRoot
$venvDir = Join-Path $workerDir ".venv"
$python = Join-Path $venvDir "Scripts\python.exe"

if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
    throw "未找到 Python Launcher，请先安装 Python 3.11。"
}

if (-not (Test-Path -LiteralPath $python)) {
    py -3.11 -m venv $venvDir
}

if (-not (Test-Path -LiteralPath $python)) {
    throw "无法创建 Python 3.11 虚拟环境。"
}

& $python -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)"
if ($LASTEXITCODE -ne 0) {
    throw "aiworker/.venv 必须使用 Python 3.11；请删除该目录后重试。"
}

& $python -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "升级 pip 失败。" }

# PyTorch 官方 Windows CUDA 12.6 wheel，RTX 3060 Ampere 可用。
& $python -m pip install torch==2.7.1 torchvision==0.22.1 --index-url https://download.pytorch.org/whl/cu126
if ($LASTEXITCODE -ne 0) { throw "安装 CUDA 版 PyTorch 失败。" }

# cn_clip 在训练数据工具里依赖 lmdb==1.3.0，该旧版本没有 Python 3.11
# Windows wheel；requirements.txt 只列出推理所需包，用 --no-deps 跳过训练依赖。
& $python -m pip install --no-deps -r (Join-Path $workerDir "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "安装 Chinese-CLIP 模型包失败。" }

& $python -c "import torch, cn_clip.clip; print('torch=' + torch.__version__); print('cuda=' + str(torch.version.cuda)); print('cuda_available=' + str(torch.cuda.is_available()))"
if ($LASTEXITCODE -ne 0) { throw "验证本地 AI 运行环境失败。" }
