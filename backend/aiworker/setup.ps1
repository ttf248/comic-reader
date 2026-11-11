$ErrorActionPreference = "Stop"

$workerDir = $PSScriptRoot
$venvDir = Join-Path $workerDir ".venv"
$isWindowsHost = $env:OS -eq "Windows_NT"
if ($isWindowsHost) {
    $python = Join-Path $venvDir "Scripts\python.exe"
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if (-not $launcher) { throw "未找到 Python Launcher，请先安装 Python 3.11。" }
    if (-not (Test-Path -LiteralPath $python)) {
        & $launcher.Source -3.11 -m venv $venvDir
        if ($LASTEXITCODE -ne 0) { throw "创建 Python 3.11 虚拟环境失败。" }
    }
} else {
    $python = Join-Path $venvDir "bin/python"
    $launcher = Get-Command python3.11 -ErrorAction SilentlyContinue
    if (-not $launcher) { throw "未找到 Python 3.11，请先安装 Python 3.11。" }
    if (-not (Test-Path -LiteralPath $python)) {
        & $launcher.Source -m venv $venvDir
        if ($LASTEXITCODE -ne 0) { throw "创建 Python 3.11 虚拟环境失败。" }
    }
}

if (-not (Test-Path -LiteralPath $python)) { throw "无法创建 Python 3.11 虚拟环境。" }
& $python -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)"
if ($LASTEXITCODE -ne 0) { throw "aiworker/.venv 必须使用 Python 3.11；请删除该目录后重试。" }

& $python -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "升级 pip 失败。" }

$torchReady = $false
& $python -c "import torch, torchvision; raise SystemExit(0 if torch.__version__.startswith('2.7.1') and torchvision.__version__.startswith('0.22.1') else 1)" 2>$null
if ($LASTEXITCODE -eq 0) { $torchReady = $true }
if (-not $torchReady) {
    if ($isWindowsHost) {
        # PyTorch 官方 Windows CUDA 12.6 wheel；没有可用 GPU 时仍可回退到 CPU。
        & $python -m pip install torch==2.7.1 torchvision==0.22.1 --index-url https://download.pytorch.org/whl/cu126
    } else {
        & $python -m pip install torch==2.7.1 torchvision==0.22.1
    }
    if ($LASTEXITCODE -ne 0) { throw "安装 PyTorch 失败。" }
}

# cn_clip 的训练工具带有旧版 lmdb 依赖；推理使用现有依赖，不安装训练依赖。
& $python -m pip install --no-deps cn_clip==1.6.0
if ($LASTEXITCODE -ne 0) { throw "安装 Chinese-CLIP 推理包失败。" }

# OCR 和人脸识别都走本机 ONNX Runtime；CPU 可用，不依赖 CUDA。
& $python -m pip install -r (Join-Path $workerDir "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "安装 OCR 与人脸识别依赖失败。" }

& $python -c "import torch, cn_clip.clip, cv2, onnxruntime, rapidocr; print('torch=' + torch.__version__); print('opencv=' + cv2.__version__); print('onnxruntime=' + onnxruntime.__version__); print('rapidocr=' + __import__('importlib.metadata').metadata.version('rapidocr'))"
if ($LASTEXITCODE -ne 0) { throw "验证本地 AI 依赖失败。" }

# 安装当前配置下的 Chinese-CLIP 与 OpenCV Zoo 固定权重，脚本会逐个校验 SHA256。
& (Join-Path $workerDir "download-model.ps1")
if ($LASTEXITCODE -ne 0) { throw "下载或校验 AI 模型失败。" }

$backendDir = Split-Path -Parent $workerDir
$cacheRoot = Join-Path $backendDir ".local-gallery"
$configPath = Join-Path $backendDir "config.yaml"
if (Test-Path -LiteralPath $configPath) {
    $cacheLine = Get-Content -LiteralPath $configPath | Where-Object { $_ -match '^\s*cacheDir\s*:' } | Select-Object -First 1
    if ($cacheLine) {
        $cacheDir = (($cacheLine -split ":", 2)[1] -replace "\s+#.*$", "").Trim().Trim('"').Trim("'")
        if (-not $cacheDir) { $cacheDir = ".local-gallery" }
        if ([System.IO.Path]::IsPathRooted($cacheDir)) {
            $cacheRoot = [System.IO.Path]::GetFullPath($cacheDir)
        } else {
            $cacheRoot = [System.IO.Path]::GetFullPath((Join-Path $backendDir $cacheDir))
        }
    }
}
$modelDir = Join-Path $cacheRoot "derived/ai/models"

& $python (Join-Path $workerDir "worker.py") $modelDir --verify-install
if ($LASTEXITCODE -ne 0) { throw "OCR / 人脸识别实际推理验证失败。" }

$pipCheck = @(& $python -m pip check 2>&1)
if ($LASTEXITCODE -ne 0) {
    $unexpected = @($pipCheck | Where-Object { $_ -notmatch '^cn-clip 1\.6\.0 requires lmdb(==1\.3\.0)?, which is not installed\.$' })
    if ($unexpected.Count -gt 0) {
        $unexpected | ForEach-Object { Write-Host $_ }
        throw "Python 依赖检查发现未预期的冲突。"
    }
    Write-Host "依赖检查通过；只忽略 Chinese-CLIP 训练工具未安装的 Windows 不兼容 lmdb。"
}

Write-Host "本机 AI 安装完成：Chinese-CLIP、中文 OCR、YuNet 人脸检测与 SFace 特征提取均已校验。"
Write-Host "模型目录：$modelDir"
Write-Host "Python 环境：$venvDir"
