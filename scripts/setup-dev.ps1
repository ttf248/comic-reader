$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw "需要 PowerShell 7 或更新版本。请使用 pwsh 运行此脚本。"
}

$missingTools = @()
foreach ($tool in @("go", "node", "npm")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    $missingTools += $tool
  }
}
if ($missingTools.Count -gt 0) {
  throw "缺少开发工具：$($missingTools -join ', ')。请先安装 Go 1.24+、Node.js 20+（含 npm）和 PowerShell 7。"
}

$goOutput = (& go version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $goOutput -notmatch '\bgo(?<version>\d+\.\d+(?:\.\d+)?)') {
  throw "无法读取 Go 版本：$goOutput"
}
if ([version]$Matches.version -lt [version]"1.24") {
  throw "当前 Go 版本过低：$goOutput。需要 Go 1.24 或更新版本。"
}

$nodeOutput = (& node --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeOutput -notmatch '^v(?<version>\d+\.\d+(?:\.\d+)?)') {
  throw "无法读取 Node.js 版本：$nodeOutput"
}
if ([version]$Matches.version -lt [version]"20.0") {
  throw "当前 Node.js 版本过低：$nodeOutput。需要 Node.js 20 或更新版本。"
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$configPath = Join-Path $repoRoot "backend/config.yaml"
$configExamplePath = Join-Path $repoRoot "backend/config.example.yaml"

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  Copy-Item -LiteralPath $configExamplePath -Destination $configPath
  Write-Host "已创建 backend/config.yaml，请设置 mediaRoots。" -ForegroundColor Green
} else {
  Write-Host "已保留现有 backend/config.yaml。" -ForegroundColor DarkGray
}

Write-Host "安装前端依赖..." -ForegroundColor Cyan
Push-Location (Join-Path $repoRoot "frontend")
try {
  & npm ci
  if ($LASTEXITCODE -ne 0) {
    throw "npm ci 失败，退出码：$LASTEXITCODE"
  }
} finally {
  Pop-Location
}

Write-Host "下载 Go 依赖..." -ForegroundColor Cyan
Push-Location (Join-Path $repoRoot "backend")
try {
  & go mod download
  if ($LASTEXITCODE -ne 0) {
    throw "go mod download 失败，退出码：$LASTEXITCODE"
  }
} finally {
  Pop-Location
}

Write-Host "开发环境准备完成。运行命令见 README.md「从源码开发」。" -ForegroundColor Green
