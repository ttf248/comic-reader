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
[System.IO.Directory]::CreateDirectory($modelDir) | Out-Null
$modelPath = Join-Path $modelDir "clip_cn_vit-b-16.pt"
$partialPath = "$modelPath.download"
$expectedSHA256 = "5997ef32c50de18f3ac06eb5d746c324a639053c3bed8f2986f97ebb22b2ecde"
$revision = "957be8390cef5bab9ddd2dd36ca81a8622f966e7"
$uri = "https://huggingface.co/OFA-Sys/chinese-clip-vit-base-patch16/resolve/$revision/clip_cn_vit-b-16.pt?download=true"

if (Test-Path -LiteralPath $modelPath) {
    $existingSHA256 = (Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($existingSHA256 -eq $expectedSHA256) {
        "Chinese-CLIP 官方权重已就绪，SHA256 校验通过。"
        exit 0
    }
}

try {
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        curl.exe --location --fail --silent --show-error --retry 4 --retry-delay 2 --output $partialPath $uri
        if ($LASTEXITCODE -ne 0) { throw "官方下载失败。" }
    } else {
        Invoke-WebRequest -Uri $uri -OutFile $partialPath
    }
    $actualSHA256 = (Get-FileHash -LiteralPath $partialPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSHA256 -ne $expectedSHA256) { throw "官方权重 SHA256 校验失败。" }
    Move-Item -LiteralPath $partialPath -Destination $modelPath -Force
    "Chinese-CLIP 官方权重下载完成，SHA256 校验通过。"
} finally {
    if (Test-Path -LiteralPath $partialPath) {
        Remove-Item -LiteralPath $partialPath -Force
    }
}
