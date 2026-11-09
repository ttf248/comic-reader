# scripts/test-e2e.ps1
# 使用临时媒体、独立前端产物与临时二进制运行真实全栈 Playwright 测试。
#
# 参数：
#   -Audit   Playwright 跑完后，再对同一个临时服务跑一遍布局 / 对比度审计。
#            临时媒体库里带真实标签（测试 / 空 格 / C++ …），所以这一次
#            审计量的是**真实标签页**，而不是开发库里那种伪造数据。
#   -Crash   Playwright 跑完后，再对同一个临时服务跑一遍相册页爆栈探针。
#            临时媒体库里有 405 项的相册，虚拟网格的测量压力足够大，
#            能把相册页偶发整页崩掉（Maximum call stack size exceeded）
#            的概率量出来 —— 这个 bug 靠"看一次页面"发现不了。

param(
  [switch]$Audit,
  [switch]$Crash
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$backendRoot = Join-Path $repoRoot "backend"
$frontendRoot = Join-Path $repoRoot "frontend"
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) "local-gallery-e2e-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$staticRoot = Join-Path $testRoot "frontend"
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

  # 浏览器解不了的格式单独放一个相册：HEIC 走服务端转换路径，没有 ffmpeg
  # 时返回 415，前端应显示明确提示而不是破图。单独放避免影响其它用例的
  # 图片序号。
  $formatDir = Join-Path (Join-Path $testRoot "media") "sample-format"
  New-Item -ItemType Directory -Path $formatDir -Force | Out-Null
  # 内容故意不是可解码的图像：模拟"格式不被支持 / 文件损坏"，服务端转换
  # 会失败并返回 415。
  [System.IO.File]::WriteAllBytes((Join-Path $formatDir "photo.heic"), [System.Text.Encoding]::ASCII.GetBytes("not a decodable image"))

  # 坏掉的 JPEG 单独放一个相册：扩展名说是 JPEG，内容却不是。服务端读
  # 图片头就会判定"无法解码"，照片墙上应显示"无法解码"而不是破图图标。
  # 单独放避免影响其它用例的图片序号。
  $brokenDir = Join-Path (Join-Path $testRoot "media") "sample-broken"
  New-Item -ItemType Directory -Path $brokenDir -Force | Out-Null
  [System.IO.File]::WriteAllBytes((Join-Path $brokenDir "broken.jpg"), [System.Text.Encoding]::ASCII.GetBytes("not a decodable image"))

  # 标签和排序使用真实扫描素材；名称、目录修改时间及媒体业务日期故意不同序。
  $taggedSamples = @(
    @{ Name = "A"; Modified = "2023-01-01T00:00:00Z"; MediaModified = "2025-01-01T00:00:00Z" },
    @{ Name = "M"; Modified = "2024-01-01T00:00:00Z"; MediaModified = "2000-01-01T00:00:00Z" },
    @{ Name = "Z"; Modified = "2022-01-01T00:00:00Z"; MediaModified = "2030-01-01T00:00:00Z" }
  )
  # 标签素材在照片根与漫画根各放一份：内容属性按目录划分，两个工作台
  # 各自都要能看到同名标签下的相册。
  foreach ($rootName in @("media", "media-comic")) {
    $rootDir = Join-Path $testRoot $rootName
    $collectionDir = Join-Path $rootDir "zz-sort-collection"
    foreach ($parent in @($rootDir, $collectionDir)) {
      foreach ($sample in $taggedSamples) {
        $taggedDir = Join-Path $parent ("zz-[测试][空 格][C++][100%][字面%20][字面%2F][字面%25] tagged-" + $sample.Name)
        New-Item -ItemType Directory -Path $taggedDir -Force | Out-Null
        $taggedImage = Join-Path $taggedDir "page.png"
        [System.IO.File]::WriteAllBytes($taggedImage, $pngBytes)
        [System.IO.File]::SetLastWriteTimeUtc($taggedImage, [DateTimeOffset]::Parse($sample.MediaModified).UtcDateTime)
        [System.IO.Directory]::SetLastWriteTimeUtc($taggedDir, [DateTimeOffset]::Parse($sample.Modified).UtcDateTime)
      }
    }
  }

  # 一本带拍摄日期文件名的相册：验证「那年今日」按月日找出往年同一天
  # 拍过照的相册。拍摄时间只认文件名，与文件修改时间无关 —— 这里把
  # mtime 压到很早，免得打乱「最近改」排序那批回归素材。
  $captureDir = Join-Path (Join-Path $testRoot "media") "zz-capture-date"
  New-Item -ItemType Directory -Path $captureDir -Force | Out-Null
  $captureImage = Join-Path $captureDir "IMG_20240115_120000.png"
  [System.IO.File]::WriteAllBytes($captureImage, $pngBytes)
  [System.IO.File]::SetLastWriteTimeUtc($captureImage, [DateTimeOffset]::Parse("2019-05-05T00:00:00Z").UtcDateTime)
  [System.IO.Directory]::SetLastWriteTimeUtc($captureDir, [DateTimeOffset]::Parse("2019-05-05T00:00:00Z").UtcDateTime)

  # 漫画根下再放一本多页漫画：继续阅读、未读与「标记为已读完」都靠它。
  $comicAlbumDir = Join-Path (Join-Path $testRoot "media-comic") "sample-comic"
  New-Item -ItemType Directory -Path $comicAlbumDir -Force | Out-Null
  1..3 | ForEach-Object {
    [System.IO.File]::WriteAllBytes((Join-Path $comicAlbumDir "page-$_.png"), $pngBytes)
  }

  # 长相册列表：主区域与集合内层各放 108 本，验证滚动到首屏之外仍能访问。
  # 放在漫画根下：这条用例在漫画工作台跑，未读页是其中一站。
  $scrollCollectionDir = Join-Path (Join-Path $testRoot "media-comic") "zz-scroll-collection"
  foreach ($parent in @((Join-Path $testRoot "media-comic"), $scrollCollectionDir)) {
    1..108 | ForEach-Object {
      $scrollAlbumDir = Join-Path $parent ("zz-[滚动回归] long-list-{0:D3}" -f $_)
      New-Item -ItemType Directory -Path $scrollAlbumDir -Force | Out-Null
      [System.IO.File]::WriteAllBytes((Join-Path $scrollAlbumDir "page.png"), $pngBytes)
    }
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

  # 20 秒、16×16 VP8：三段可实际解码的视频，避免快进 5 秒直接到片尾。
  $keyboardVideoDir = Join-Path (Join-Path $testRoot "media") "sample-video-shortcuts"
  New-Item -ItemType Directory -Path $keyboardVideoDir -Force | Out-Null
  $keyboardVideoBytes = [Convert]::FromBase64String("GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAVnEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggVR7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDFXQYxMYXZmNjMuMS4xMDFEiYhA04gAAAAAABZUrmvXrgEAAAAAAABO14EBc8WIOcx4BAve1WucgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4Q7msoA4JCwgRC6gRCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/pzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAxc3PVY8CLY8WIOcx4BAve1WtnyKBFo4dFTkNPREVSRIeTTGF2YzYzLjEuMTAxIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MjAuMDAwMDAwMDAwAB9DtnVBGeeBAKO9gQAAgLACAJ0BKhAAEAAARwiFhYiZhIgCAgJ1qgP4Agz9+wD+/00S//xKp/Eqn8Sqf/Eqn/0Yfww/hh/eEKOpgQPoALEBAAUQrAAYADA/9AwA7wD+8mav/XAfnAfnAfzLeB4fh4fhugCjqYEH0ACxAQAFEKwAGAAwP/QMAO8A/vJmr/1wH5wH5wH8y3geH4eH4boAo6mBC7gAsQEABRCsABgAMD/0DADvAP7yZq/9cB+cB+cB/Mt4Hh+Hh+G6AKOpgQ+gALEBAAUQrAAYADA/9AwA7wD+8mav/XAfnAfnAfzLeB4fh4fhugCjqYETiACxAQAFEKwAGAAwP/QMAO8A/vJmr/1wH5wH5wH8y3geH4eH4boAH0O2dUEL54IXcKOpgQAAALEBAAUQrAAYADA/9AwA7wD+8mav/XAfnAfnAfzLeB4fh4fhugCjroED6ACxAQAFEBAUYADA/9AwA7wA/v9NEv/8SqfxKp/Eqn/xKp/9GH8MP4Yf3hCjqYEH0ACxAQAFEKwAGAAwP/QMAO8A/vJmr/1wH5wH5wH8y3geH4eH4boAo6mBC7gAsQEABRCsABgAMD/0DADvAP7yZq/9cB+cB+cB/Mt4Hh+Hh+G6AKOpgQ+gALEBAAUQrAAYADA/9AwA7wD+8mav/XAfnAfnAfzLeB4fh4fhugCjqYETiACxAQAFEKwAGAAwP/QMAO8A/vJmr/1wH5wH5wH8y3geH4eH4boAH0O2dUEL54Iu4KOpgQAAALEBAAUQrAAYADA/9AwA7wD+8mav/XAfnAfnAfzLeB4fh4fhugCjqYED6ACxAQAFEKwAGAAwP/QMAO8A/vJmr/1wH5wH5wH8y3geH4eH4boAo66BB9AAsQEABRAQFGAAwP/QMAO8AP7/TRL//Eqn8SqfxKp/8Sqf/Rh/DD+GH94Qo6mBC7gAsQEABRCsABgAMD/0DADvAP7yZq/9cB+cB+cB/Mt4Hh+Hh+G6AKOpgQ+gALEBAAUQrAAYADA/9AwA7wD+8mav/XAfnAfnAfzLeB4fh4fhugCjqYETiACxAQAFEKwAGAAwP/QMAO8A/vJmr/1wH5wH5wH8y3geH4eH4boAH0O2ddrngkZQo6mBAAAAsQEABRCsABgAMD/0DADvAP7yZq/9cB+cB+cB/Mt4Hh+Hh+G6AKOpgQPoALEBAAUQrAAYADA/9AwA7wD+8mav/XAfnAfnAfzLeB4fh4fhugAcU7trkbuPs4EAt4r3gQHxggGx8IED")
  foreach ($suffix in @("A", "B", "C")) {
    [System.IO.File]::WriteAllBytes((Join-Path $keyboardVideoDir "clip-$suffix.webm"), $keyboardVideoBytes)
  }

  $mediaPathYaml = (Join-Path $testRoot "media").Replace("\", "/")
  $comicPathYaml = (Join-Path $testRoot "media-comic").Replace("\", "/")
  $cachePathYaml = (Join-Path $testRoot "cache").Replace("\", "/")
  $staticPathYaml = $staticRoot.Replace("\", "/")
  $config = @"
mediaRoots:
  - path: "$mediaPathYaml"
    kind: photo
  - path: "$comicPathYaml"
    kind: comic
  - path: "$mediaPathYaml-offline"
    kind: photo
host: "127.0.0.1"
port: $testPort
cacheDir: "$cachePathYaml"
staticDir: "$staticPathYaml"
"@
  [System.IO.File]::WriteAllText($cfgPath, $config, [System.Text.UTF8Encoding]::new($false))

  Write-Host "[1/4] 构建前端与临时后端..." -ForegroundColor Cyan
  # Vite 会清理输出目录；必须确认目标仅为当前测试根下的独立子目录。
  if ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($staticRoot)) -ne
      [System.IO.Path]::GetFullPath($testRoot)) { throw "拒绝构建到当前测试目录之外的路径" }
  Push-Location $frontendRoot
  try {
    # 保留字面分隔符，避免 npm.ps1 吞掉传给 Vite 的构建参数。
    npm run build '--' '--outDir' $staticRoot '--emptyOutDir'
    if ($LASTEXITCODE -ne 0) { throw "前端构建失败" }
  } finally { Pop-Location }
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

  if ($Audit) {
    # 同一个临时服务上再跑一遍审计：临时媒体库里有真实标签，
    # 这一次量到的是真实标签页（开发库的 /api/tags 是空的）。
    Write-Host "[3.5/4] 对临时服务跑布局 / 对比度审计..." -ForegroundColor Cyan
    Push-Location $frontendRoot
    try {
      $env:LG_BASE = $env:PLAYWRIGHT_BASE_URL
      node scripts/layout-audit.mjs
      if ($LASTEXITCODE -ne 0) { throw "布局审计失败，退出码 $LASTEXITCODE" }
      node scripts/contrast-audit.mjs
      if ($LASTEXITCODE -ne 0) { throw "对比度审计失败，退出码 $LASTEXITCODE" }
    } finally {
      Pop-Location
      Remove-Item Env:\LG_BASE -ErrorAction SilentlyContinue
    }
  }

  if ($Crash) {
    # 同一个临时服务上量相册页的崩溃率：临时媒体库里有 405 项的相册，
    # 虚拟网格的测量压力足够大，能把这个偶发 bug 的概率量成数字。
    Write-Host "[3.6/4] 对临时服务跑相册页爆栈探针..." -ForegroundColor Cyan
    Push-Location $frontendRoot
    try {
      $env:LG_BASE = $env:PLAYWRIGHT_BASE_URL
      $env:LG_CRASH_ALBUM = "sample-paged-videos"
      $env:LG_CRASH_VISITS = "10"
      node scripts/album-crash-probe.mjs
      if ($LASTEXITCODE -ne 0) { throw "相册页爆栈探针发现崩溃，退出码 $LASTEXITCODE" }
    } finally {
      Pop-Location
      Remove-Item Env:\LG_BASE -ErrorAction SilentlyContinue
      Remove-Item Env:\LG_CRASH_ALBUM -ErrorAction SilentlyContinue
      Remove-Item Env:\LG_CRASH_VISITS -ErrorAction SilentlyContinue
    }
  }
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
