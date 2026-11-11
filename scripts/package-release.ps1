# scripts/package-release.ps1
# 生成一个可直接解压运行的当前架构发布包：二进制 + 前端 dist + 文档 + 示例配置 + 本机 AI Worker。

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [Parameter(Mandatory = $true)]
  [ValidateSet("linux", "windows", "darwin")]
  [string]$TargetOS,
  [Parameter(Mandatory = $true)]
  [ValidateSet("amd64", "arm64")]
  [string]$TargetArch,
  [string]$OutputDir = "artifacts",
  [switch]$SkipFrontend
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$resolvedOutputDir = if ([System.IO.Path]::IsPathRooted($OutputDir)) {
  [System.IO.Path]::GetFullPath($OutputDir)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
}
$workRoot = Join-Path ([System.IO.Path]::GetTempPath()) "local-gallery-package-$([guid]::NewGuid().ToString('N'))"
$buildDir = Join-Path $workRoot "bin"

if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
  throw "Version 必须是有效的 SemVer（不带 v 前缀）。"
}

New-Item -ItemType Directory -Path $resolvedOutputDir -Force | Out-Null
New-Item -ItemType Directory -Path $workRoot -Force | Out-Null

try {
  $buildArgs = @(
    "-NoProfile",
    "-File",
    (Join-Path $PSScriptRoot "build.ps1"),
    "-OutputDir",
    $buildDir,
    "-Version",
    $Version,
    "-TargetOS",
    $TargetOS,
    "-TargetArch",
    $TargetArch,
    "-SkipInstall"
  )
  if ($SkipFrontend) {
    $buildArgs += "-SkipFrontend"
  }
  & pwsh @buildArgs
  if ($LASTEXITCODE -ne 0) {
    throw "构建二进制失败，退出码 $LASTEXITCODE。"
  }

  $binaryName = "local-gallery"
  if ($TargetOS -eq "windows") {
    $binaryName += ".exe"
  }
  $binaryPath = Join-Path $buildDir $binaryName
  $distPath = Join-Path (Join-Path $repoRoot "frontend") "dist"
  $configExamplePath = Join-Path (Join-Path $repoRoot "backend") "config.example.yaml"
  if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
    throw "找不到构建产物：$binaryPath"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $distPath "index.html") -PathType Leaf)) {
    throw "找不到前端产物：$distPath\index.html；请先构建前端或不要使用 -SkipFrontend。"
  }

  $packageName = "local-gallery-v$Version-$TargetOS-$TargetArch"
  $packageRoot = Join-Path $workRoot $packageName
  New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $packageRoot "dist") -Force | Out-Null

  Copy-Item -LiteralPath $binaryPath -Destination (Join-Path $packageRoot $binaryName)
  Copy-Item -Path (Join-Path $distPath "*") -Destination (Join-Path $packageRoot "dist") -Recurse -Force
  Copy-Item -LiteralPath $configExamplePath -Destination (Join-Path $packageRoot "config.example.yaml")
  Copy-Item -LiteralPath (Join-Path $repoRoot "README.md") -Destination (Join-Path $packageRoot "README.md")
  Copy-Item -LiteralPath (Join-Path $repoRoot "AGENTS.md") -Destination (Join-Path $packageRoot "AGENTS.md")
  Copy-Item -LiteralPath (Join-Path $repoRoot "docs") -Destination (Join-Path $packageRoot "docs") -Recurse -Force
  $packageBackendDir = Join-Path $packageRoot "backend"
  New-Item -ItemType Directory -Path $packageBackendDir -Force | Out-Null
  Copy-Item -LiteralPath $configExamplePath -Destination (Join-Path $packageBackendDir "config.example.yaml")
  $workerSourceDir = Join-Path (Join-Path $repoRoot "backend") "aiworker"
  $workerTargetDir = Join-Path $packageRoot "aiworker"
  New-Item -ItemType Directory -Path $workerTargetDir -Force | Out-Null
  foreach ($workerFile in @("worker.py", "requirements.txt", "setup.ps1", "download-model.ps1")) {
    Copy-Item -LiteralPath (Join-Path $workerSourceDir $workerFile) -Destination (Join-Path $workerTargetDir $workerFile)
  }
  $licensePath = Join-Path $repoRoot "LICENSE"
  if (Test-Path -LiteralPath $licensePath -PathType Leaf) {
    Copy-Item -LiteralPath $licensePath -Destination (Join-Path $packageRoot "LICENSE")
  }

  $archiveName = "$packageName"
  if ($TargetOS -eq "windows") {
    $archiveName += ".zip"
    $archivePath = Join-Path $resolvedOutputDir $archiveName
    Compress-Archive -Path (Join-Path $packageRoot "*") -DestinationPath $archivePath -Force
  } else {
    $archiveName += ".tar.gz"
    $archivePath = Join-Path $resolvedOutputDir $archiveName
    & tar -czf $archivePath -C $workRoot $packageName
    if ($LASTEXITCODE -ne 0) {
      throw "生成 tar.gz 失败，退出码 $LASTEXITCODE。"
    }
  }

  Write-Host "发布包已生成：$archivePath" -ForegroundColor Green
} finally {
  if (Test-Path -LiteralPath $workRoot) {
    Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
