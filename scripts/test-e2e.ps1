# scripts/test-e2e.ps1
# 使用临时媒体目录与临时二进制运行真实全栈 Playwright 测试。

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$backendRoot = Join-Path $repoRoot "backend"
$frontendRoot = Join-Path $repoRoot "frontend"
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) "local-gallery-e2e-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$sampleDir = Join-Path (Join-Path $testRoot "media") "sample-album"
$portListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$portListener.Start()
$testPort = $portListener.LocalEndpoint.Port
$portListener.Stop()
$previousBaseURL = $env:PLAYWRIGHT_BASE_URL
$env:PLAYWRIGHT_BASE_URL = "http://127.0.0.1:$testPort"
$serverName = if ($IsWindows -or $env:OS -eq "Windows_NT") { "server.exe" } else { "server" }
$serverPath = Join-Path $testRoot $serverName
$cfgPath = Join-Path $testRoot "config.yaml"
$stdoutPath = Join-Path $testRoot "server.stdout.log"
$stderrPath = Join-Path $testRoot "server.stderr.log"
$backendProcess = $null

try {
  New-Item -ItemType Directory -Path $sampleDir -Force | Out-Null
  $pngBytes = [Convert]::FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
  1..3 | ForEach-Object {
    [System.IO.File]::WriteAllBytes((Join-Path $sampleDir "page-$_.png"), $pngBytes)
  }

  # 标签收藏需要由真实目录名解析，避免只验证前端模拟数据。
  # 同标签至少两个相册才会生成智能合集。
  1..2 | ForEach-Object {
    $taggedDir = Join-Path (Join-Path $testRoot "media") "zz-[测试] tagged-$_"
    New-Item -ItemType Directory -Path $taggedDir -Force | Out-Null
    [System.IO.File]::WriteAllBytes((Join-Path $taggedDir "page.png"), $pngBytes)
  }

  # 超过两页的轻量素材，验证三个虚拟媒体网格的分页边界和远距离跳转。
  foreach ($kind in @("images", "mixed", "videos")) {
    $pagedDir = Join-Path (Join-Path $testRoot "media") "sample-paged-$kind"
    New-Item -ItemType Directory -Path $pagedDir -Force | Out-Null
    1..405 | ForEach-Object {
      $extension = if ($kind -eq "videos") { "mp4" } else { "png" }
      [System.IO.File]::WriteAllBytes((Join-Path $pagedDir "page-$_.$extension"), $pngBytes)
    }
    if ($kind -eq "mixed") {
      [System.IO.File]::WriteAllBytes((Join-Path $pagedDir "zz-video.mp4"), $pngBytes)
    }
  }

  # 16×16、2 秒 VP8 WebM，用于浏览器实际解码与抽帧，不依赖测试机安装 ffmpeg。
  $coverDir = Join-Path (Join-Path $testRoot "media") "sample-video-cover"
  New-Item -ItemType Directory -Path $coverDir -Force | Out-Null
  $videoBytes = [Convert]::FromBase64String("GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAJTEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggI97AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDFXQYxMYXZmNjMuMS4xMDFEiYhAn0AAAAAAABZUrmvXrgEAAAAAAABO14EBc8WIAN7+EvCpIL6cgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QdzWUA4JCwgRC6gRCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/pzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAxc3PVY8CLY8WIAN7+EvCpIL5nyKBFo4dFTkNPREVSRIeTTGF2YzYzLjEuMTAxIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDIuMDAwMDAwMDAwAB9DtnVAhueBAKO8gQAAgLACAJ0BKhAAEAAARwiFhYiFhIgCAgJ1qgP4Agz9KAD+/00S//xYV/FhX8WFf/FhX/z8zu3F/OYAo5WBAfQAsQEAARAQABgAGFgv9AAIAACjlYED6ACxAQABEBAAGAAYWC/0AAgAAKOVgQXcALEBAAEQEAAYABhYL/QACAAAHFO7a5G7j7OBALeK94EB8YIBsfCBAw==")
  [System.IO.File]::WriteAllBytes((Join-Path $coverDir "clip.webm"), $videoBytes)
  $mixedCoverDir = Join-Path (Join-Path $testRoot "media") "sample-mixed-cover"
  New-Item -ItemType Directory -Path $mixedCoverDir -Force | Out-Null
  [System.IO.File]::WriteAllBytes((Join-Path $mixedCoverDir "clip.webm"), $videoBytes)
  [System.IO.File]::WriteAllBytes((Join-Path $mixedCoverDir "page.png"), $pngBytes)
  [System.IO.File]::WriteAllBytes((Join-Path $mixedCoverDir "page-2.png"), $pngBytes)

  $mediaPathYaml = (Join-Path $testRoot "media").Replace("\", "/")
  $cachePathYaml = (Join-Path $testRoot "cache").Replace("\", "/")
  $staticPathYaml = (Join-Path $frontendRoot "dist").Replace("\", "/")
  $config = @"
mediaRoots:
  - "$mediaPathYaml"
  - "$mediaPathYaml-offline"
host: "127.0.0.1"
port: $testPort
cacheDir: "$cachePathYaml"
staticDir: "$staticPathYaml"
"@
  [System.IO.File]::WriteAllText($cfgPath, $config, [System.Text.UTF8Encoding]::new($false))

  Write-Host "[1/4] 构建前端与临时后端..." -ForegroundColor Cyan
  Push-Location $frontendRoot
  try { npm run build; if ($LASTEXITCODE -ne 0) { throw "前端构建失败" } } finally { Pop-Location }
  Push-Location $backendRoot
  try { go build -o $serverPath ./cmd/server; if ($LASTEXITCODE -ne 0) { throw "后端构建失败" } } finally { Pop-Location }

  Write-Host "[2/4] 启动临时服务..." -ForegroundColor Cyan
  $processOptions = @{
    FilePath = $serverPath
    ArgumentList = @("--config", ('"' + $cfgPath + '"'))
    WorkingDirectory = $backendRoot
    RedirectStandardOutput = $stdoutPath
    RedirectStandardError = $stderrPath
    PassThru = $true
  }
  if ($IsWindows) { $processOptions.WindowStyle = "Hidden" }
  $backendProcess = Start-Process @processOptions
  $ready = $false
  $curlCommand = if (Get-Command curl.exe -ErrorAction SilentlyContinue) { "curl.exe" } else { "curl" }
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if ($backendProcess.HasExited) { throw "临时服务提前退出，退出码 $($backendProcess.ExitCode)" }
    & $curlCommand --noproxy "*" --silent --fail --max-time 1 "$env:PLAYWRIGHT_BASE_URL/api/health" | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $ready = $true
      break
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) {
    $stderr = if (Test-Path $stderrPath) { Get-Content $stderrPath -Raw } else { "" }
    throw "临时服务启动失败。$stderr"
  }

  Write-Host "[3/4] 运行 Playwright..." -ForegroundColor Cyan
  Push-Location $frontendRoot
  try {
    npx playwright test
    if ($LASTEXITCODE -ne 0) {
      throw "Playwright 测试失败，退出码 $LASTEXITCODE"
    }
  } finally { Pop-Location }
} finally {
  Write-Host "[4/4] 清理临时进程与测试目录..." -ForegroundColor Cyan
  if ($null -ne $backendProcess -and -not $backendProcess.HasExited) {
    Stop-Process -Id $backendProcess.Id -Force -ErrorAction SilentlyContinue
    $backendProcess.WaitForExit(5000) | Out-Null
  }
  if (Test-Path $testRoot) {
    $resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
    $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedTestRoot.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not ([System.IO.Path]::GetFileName($resolvedTestRoot)).StartsWith("local-gallery-e2e-")) { throw "拒绝清理测试目录之外的路径" }
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($null -eq $previousBaseURL) { Remove-Item Env:PLAYWRIGHT_BASE_URL -ErrorAction SilentlyContinue } else { $env:PLAYWRIGHT_BASE_URL = $previousBaseURL }
}
