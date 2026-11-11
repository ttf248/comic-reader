$ErrorActionPreference = "Stop"

$backendDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$configPath = Join-Path $backendDir "config.yaml"
$cacheDir = ".local-gallery"
if (Test-Path -LiteralPath $configPath) {
    $cacheLine = Get-Content -LiteralPath $configPath | Where-Object { $_ -match '^\s*cacheDir\s*:' } | Select-Object -First 1
    if ($cacheLine) {
        $cacheDir = (($cacheLine -split ":", 2)[1] -replace "\s+#.*$", "").Trim().Trim('"').Trim("'")
        if (-not $cacheDir) { $cacheDir = ".local-gallery" }
    }
}

if ([System.IO.Path]::IsPathRooted($cacheDir)) {
    $cacheRoot = [System.IO.Path]::GetFullPath($cacheDir)
} else {
    $cacheRoot = [System.IO.Path]::GetFullPath((Join-Path $backendDir $cacheDir))
}
$modelDir = Join-Path $cacheRoot "derived/ai/models"
$faceModelDir = Join-Path $modelDir "face"
[System.IO.Directory]::CreateDirectory($modelDir) | Out-Null
[System.IO.Directory]::CreateDirectory($faceModelDir) | Out-Null

function Install-VerifiedModel([string]$Name, [string]$Uri, [string]$Destination, [string]$ExpectedSHA256) {
    if (Test-Path -LiteralPath $Destination) {
        $existing = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($existing -eq $ExpectedSHA256) {
            Write-Host "$Name 权重已就绪，SHA256 校验通过。"
            return
        }
        Remove-Item -LiteralPath $Destination -Force
    }

    $partialPath = "$Destination.download"
    try {
        Write-Host "正在下载 $Name ..."
        if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
            & curl.exe --location --fail --silent --show-error --retry 4 --retry-delay 2 --output $partialPath $Uri
            if ($LASTEXITCODE -ne 0) { throw "$Name 官方权重下载失败。" }
        } else {
            Invoke-WebRequest -Uri $Uri -OutFile $partialPath
        }
        $actual = (Get-FileHash -LiteralPath $partialPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $ExpectedSHA256) { throw "$Name 官方权重 SHA256 校验失败。" }
        Move-Item -LiteralPath $partialPath -Destination $Destination -Force
        Write-Host "$Name 下载完成，SHA256 校验通过。"
    } finally {
        if (Test-Path -LiteralPath $partialPath) { Remove-Item -LiteralPath $partialPath -Force }
    }
}

Install-VerifiedModel `
    "Chinese-CLIP" `
    "https://huggingface.co/OFA-Sys/chinese-clip-vit-base-patch16/resolve/957be8390cef5bab9ddd2dd36ca81a8622f966e7/clip_cn_vit-b-16.pt?download=true" `
    (Join-Path $modelDir "clip_cn_vit-b-16.pt") `
    "5997ef32c50de18f3ac06eb5d746c324a639053c3bed8f2986f97ebb22b2ecde"

$faceRevision = "d4938dfc9d4ec5d098bfa33e98b3f3345a236586"
Install-VerifiedModel `
    "YuNet 人脸检测" `
    "https://huggingface.co/opencv/opencv_zoo/resolve/$faceRevision/models/face_detection_yunet/face_detection_yunet_2023mar.onnx" `
    (Join-Path $faceModelDir "face_detection_yunet_2023mar.onnx") `
    "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"

Install-VerifiedModel `
    "SFace 人脸特征" `
    "https://huggingface.co/opencv/opencv_zoo/resolve/$faceRevision/models/face_recognition_sface/face_recognition_sface_2021dec.onnx" `
    (Join-Path $faceModelDir "face_recognition_sface_2021dec.onnx") `
    "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"

"模型目录：$modelDir"
