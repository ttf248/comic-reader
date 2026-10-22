# scripts/publish.ps1
# 校验当前改动 → 提交已暂存文件 → 推送当前分支。CI 需在 GitHub 手动运行。
# 默认不强制推送；远端拒绝时保留本地提交并让调用方处理分支分歧。

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Message,
  [string]$Remote = "origin",
  [string]$Branch = "",
  [switch]$SkipValidation
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Invoke-GitChecked {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  Push-Location $repoRoot
  try {
    & git @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "Git 命令失败（退出码 $LASTEXITCODE）：git $($Arguments -join ' ')"
    }
  } finally {
    Pop-Location
  }
}

function Invoke-ValidationCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )

  Push-Location $WorkingDirectory
  try {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "校验命令失败（退出码 $LASTEXITCODE）：$FilePath $($Arguments -join ' ')"
    }
  } finally {
    Pop-Location
  }
}

$currentBranch = (& git -C $repoRoot branch --show-current).Trim()
if ([string]::IsNullOrWhiteSpace($currentBranch)) {
  throw "当前处于 detached HEAD，不能自动推送。"
}
if ([string]::IsNullOrWhiteSpace($Branch)) {
  $Branch = $currentBranch
}

if (-not $SkipValidation) {
  Write-Host "[1/5] 构建前端与后端..." -ForegroundColor Cyan
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot "build.ps1")
  if ($LASTEXITCODE -ne 0) {
    throw "构建失败，已停止提交和推送。"
  }

  Write-Host "[2/5] 运行后端测试..." -ForegroundColor Cyan
  Invoke-ValidationCommand "go" @("test", "./...") (Join-Path $repoRoot "backend")

  Write-Host "[3/5] 运行前端静态检查与测试..." -ForegroundColor Cyan
  Invoke-ValidationCommand "npm" @("run", "lint") (Join-Path $repoRoot "frontend")
  Invoke-ValidationCommand "npm" @("run", "test") (Join-Path $repoRoot "frontend")
} else {
  Write-Host "[1/5] 已跳过本地构建和测试。" -ForegroundColor Yellow
}

$statusBefore = (& git -C $repoRoot diff --cached --name-only)
if ([string]::IsNullOrWhiteSpace(($statusBefore -join "`n"))) {
  throw "暂存区没有可提交的改动，请先用 git add 暂存本次任务的文件。"
}

Write-Host "[4/5] 提交已暂存的改动..." -ForegroundColor Cyan
Invoke-GitChecked @("diff", "--cached", "--check")
$messagePath = [System.IO.Path]::GetTempFileName()
try {
  [System.IO.File]::WriteAllText($messagePath, $Message, [System.Text.UTF8Encoding]::new($false))
  Invoke-GitChecked @("commit", "--file", $messagePath)
} finally {
  Remove-Item -LiteralPath $messagePath -Force
}
$commitSha = (& git -C $repoRoot rev-parse HEAD).Trim()

Write-Host "[5/5] 推送 $commitSha 到 $Remote/$Branch..." -ForegroundColor Cyan
Invoke-GitChecked @("push", $Remote, "HEAD:$Branch")
Write-Host "推送完成。" -ForegroundColor Green

Write-Host "如需远端验证，请在 GitHub Actions 手动运行 CI。" -ForegroundColor Cyan
