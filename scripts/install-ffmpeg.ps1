# scripts/install-ffmpeg.ps1
# 绿色安装 ffmpeg/ffprobe 到 <RepoRoot>/bin/ffmpeg/windows/amd64/。
#
# 设计原则:
#   - 不写系统目录、不改 PATH、不需要管理员权限
#   - 幂等:目标 ffmpeg.exe 已存在且 -version 可用就跳过
#   - 默认从 gyan.dev 拉 ffmpeg-release-essentials.zip(GPL,约 80MB,只含 essentials)
#   - 用完清理临时下载/解压目录
#
# 参数:
#   -Force        强制重装(忽略已存在检查)
#   -Url <url>    自定义 zip 下载地址
#   -TargetDir <p> 自定义安装目录(默认 bin/ffmpeg/windows/amd64)
#
# 退出码:
#   0  成功(或已是最新)
#   1  参数错误
#   2  下载失败
#   3  解压失败
#   4  找不到 ffmpeg.exe
#   5  自检失败
#
# 用法:
#   pwsh -File scripts/install-ffmpeg.ps1
#   pwsh -File scripts/install-ffmpeg.ps1 -Force
#   pwsh -File scripts/install-ffmpeg.ps1 -Url "https://example.com/ffmpeg.zip"

[CmdletBinding()]
param(
    [switch]$Force,
    [string]$Url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    [string]$TargetDir = ""
)

$ErrorActionPreference = "Stop"
# 关掉进度条:非交互式 PowerShell 里 Invoke-WebRequest 内部的 Write-Progress
# 会让某些 host(本工具)直接 abort 整个脚本。
$ProgressPreference   = "SilentlyContinue"

# ---- 1. 定位仓库根 ----------------------------------------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir "..")

if ([string]::IsNullOrEmpty($TargetDir)) {
    $TargetDir = Join-Path $RepoRoot "bin/ffmpeg/windows/amd64"
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host " Comic Reader - ffmpeg 绿色安装" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "目标目录: $TargetDir"
Write-Host "下载来源: $Url"
Write-Host ""

# ---- 2. 幂等检查 ------------------------------------------------------
$ffmpegExe = Join-Path $TargetDir "ffmpeg.exe"
$ffprobeExe = Join-Path $TargetDir "ffprobe.exe"

if (-not $Force -and (Test-Path $ffmpegExe) -and (Test-Path $ffprobeExe)) {
    try {
        $verOutput = & $ffmpegExe -version 2>&1 | Select-Object -First 1
        if ($verOutput -and $verOutput -match "ffmpeg version") {
            Write-Host "[OK] 已安装,跳过。检测到:" -ForegroundColor Green
            Write-Host "     $verOutput"
            Write-Host ""
            Write-Host "如需重装,加 -Force。" -ForegroundColor DarkGray
            exit 0
        }
    } catch {
        Write-Host "[WARN] 目标文件存在但自检失败,继续重装。" -ForegroundColor Yellow
    }
}

# ---- 3. 准备目录 ------------------------------------------------------
New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null

$tempZip     = Join-Path $env:TEMP ("ffmpeg-dl-" + [Guid]::NewGuid().ToString("N") + ".zip")
$tempExtract = Join-Path $env:TEMP ("ffmpeg-extract-" + [Guid]::NewGuid().ToString("N"))

# ---- 4. 下载 ---------------------------------------------------------
Write-Host "[1/4] 下载 ffmpeg ..." -ForegroundColor Cyan
try {
    # UseBasicParsing 让 Windows PowerShell 5.1 不依赖 IE 组件;
    # 进度条已通过脚本顶部 $ProgressPreference = SilentlyContinue 关掉。
    Invoke-WebRequest -Uri $Url -OutFile $tempZip -UseBasicParsing -ErrorAction Stop
} catch {
    Remove-Item -Force -ErrorAction SilentlyContinue $tempZip, $tempExtract
    Write-Host "[FAIL] 下载失败: $_" -ForegroundColor Red
    exit 2
}

$sizeMB = [math]::Round((Get-Item $tempZip).Length / 1MB, 1)
Write-Host "      已下载 $sizeMB MB -> $tempZip" -ForegroundColor DarkGray

# ---- 5. 解压 ---------------------------------------------------------
Write-Host "[2/4] 解压 ..." -ForegroundColor Cyan
try {
    Expand-Archive -Path $tempZip -DestinationPath $tempExtract -Force -ErrorAction Stop
} catch {
    Remove-Item -Force -ErrorAction SilentlyContinue $tempZip, $tempExtract
    Write-Host "[FAIL] 解压失败: $_" -ForegroundColor Red
    exit 3
}

# ---- 6. 定位 bin 子目录 ---------------------------------------------
Write-Host "[3/4] 拷贝二进制到目标目录 ..." -ForegroundColor Cyan
# gyan essentials 解压后形如: ffmpeg-7.1-essentials_build/bin/ffmpeg.exe
$binDir = Get-ChildItem -Path $tempExtract -Recurse -Directory -Filter "bin" -ErrorAction SilentlyContinue |
          Where-Object { Test-Path (Join-Path $_.FullName "ffmpeg.exe") } |
          Select-Object -First 1

if (-not $binDir) {
    Remove-Item -Force -Recurse -ErrorAction SilentlyContinue $tempZip, $tempExtract
    Write-Host "[FAIL] 在 zip 中找不到 ffmpeg.exe (结构与预期不符)。" -ForegroundColor Red
    Write-Host "       如来源已变,请用 -Url 指定新地址,或手动解压后调整。" -ForegroundColor Red
    exit 4
}

Copy-Item -Path (Join-Path $binDir.FullName "*") -Destination $TargetDir -Force

# ---- 7. 自检 ---------------------------------------------------------
Write-Host "[4/4] 自检 ..." -ForegroundColor Cyan
$ffmpegVer  = & $ffmpegExe  -version 2>&1 | Select-Object -First 1
$ffprobeVer = & $ffprobeExe -version 2>&1 | Select-Object -First 1

if (-not $ffmpegVer -or $ffmpegVer -notmatch "ffmpeg version") {
    Remove-Item -Force -Recurse -ErrorAction SilentlyContinue $ffmpegExe, $ffprobeExe
    Write-Host "[FAIL] ffmpeg 自检未通过。" -ForegroundColor Red
    Write-Host "       输出: $ffmpegVer" -ForegroundColor Red
    exit 5
}
if (-not $ffprobeVer -or $ffprobeVer -notmatch "ffprobe version") {
    Write-Host "[WARN] ffprobe 自检未通过,但 ffmpeg 可用。继续。" -ForegroundColor Yellow
}

# ---- 8. 清理 ---------------------------------------------------------
Remove-Item -Force -ErrorAction SilentlyContinue $tempZip
Remove-Item -Force -Recurse -ErrorAction SilentlyContinue $tempExtract

# ---- 9. 完成 ---------------------------------------------------------
Write-Host ""
Write-Host "[DONE] 安装完成" -ForegroundColor Green
Write-Host "       ffmpeg:  $ffmpegVer"
Write-Host "       ffprobe: $ffprobeVer"
Write-Host "       路径:    $TargetDir"
Write-Host ""
Write-Host "注: ffmpeg/ffprobe 提供视频抽帧、元数据、转码与特殊图片转换。" -ForegroundColor DarkGray
Write-Host "    未安装时封面回退到浏览器抽帧；需转码的视频与特殊图片可能无法显示。" -ForegroundColor DarkGray
Write-Host "    详见 README「可选依赖」小节 + docs/ARCHITECTURE.md「图片、缩略图与预览」。" -ForegroundColor DarkGray
Write-Host ""
exit 0
