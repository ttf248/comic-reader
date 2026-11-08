# scripts/build.ps1
# 构建当前 Go + React 版本。默认构建前端并输出后端二进制。
#
# 该脚本使用相对仓库根目录的路径，可在 Windows / macOS / Linux 的
# PowerShell 7 中运行。发布工作流通过 -Version 注入同一个版本号，
# 避免前后端版本显示不一致。

[CmdletBinding()]
param(
  [string]$OutputDir = "bin",
  [string]$Version = "",
  [ValidateSet("", "linux", "windows", "darwin")]
  [string]$TargetOS = "",
  [ValidateSet("", "amd64", "arm64")]
  [string]$TargetArch = "",
  [switch]$Local,
  [switch]$SkipInstall,
  [switch]$SkipFrontend
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Resolve-RepositoryPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  if ([System.IO.Path]::IsPathRooted($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }

  return [System.IO.Path]::GetFullPath((Join-Path $repoRoot $Path))
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )

  Push-Location $WorkingDirectory
  try {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "命令执行失败（退出码 $LASTEXITCODE）：$FilePath $($Arguments -join ' ')"
    }
  } finally {
    Pop-Location
  }
}

function Get-GoEnvironmentValue {
  param([Parameter(Mandatory = $true)][string]$Name)

  Push-Location $backendRoot
  try {
    $value = (& go env $Name).Trim()
    if ([string]::IsNullOrWhiteSpace($value)) {
      throw "无法读取 Go 环境变量：$Name"
    }
    return $value
  } finally {
    Pop-Location
  }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$frontendRoot = Join-Path $repoRoot "frontend"
$backendRoot = Join-Path $repoRoot "backend"
$resolvedOutputDir = Resolve-RepositoryPath $OutputDir

if ($Local -and (-not [string]::IsNullOrWhiteSpace($TargetOS) -or
    -not [string]::IsNullOrWhiteSpace($TargetArch))) {
  throw "Local 不能与 TargetOS 或 TargetArch 同时使用。"
}

if (-not [string]::IsNullOrWhiteSpace($Version) -and
    $Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
  throw "Version 必须是不带 v 前缀的 SemVer，例如 2.0.0 或 2.0.0-rc.1。"
}

$effectiveTargetOS = if ($Local) {
  Get-GoEnvironmentValue "GOHOSTOS"
} elseif ([string]::IsNullOrWhiteSpace($TargetOS)) {
  Get-GoEnvironmentValue "GOOS"
} else {
  $TargetOS
}
$effectiveTargetArch = if ($Local) {
  Get-GoEnvironmentValue "GOHOSTARCH"
} elseif ([string]::IsNullOrWhiteSpace($TargetArch)) {
  Get-GoEnvironmentValue "GOARCH"
} else {
  $TargetArch
}

New-Item -ItemType Directory -Path $resolvedOutputDir -Force | Out-Null
$binaryName = "local-gallery"
if ($effectiveTargetOS -eq "windows") {
  $binaryName += ".exe"
}
$serverPath = Join-Path $resolvedOutputDir $binaryName

$oldGoOS = $env:GOOS
$oldGoArch = $env:GOARCH
$oldCgoEnabled = $env:CGO_ENABLED
$oldAppVersion = $env:LOCAL_GALLERY_VERSION

try {
  # 显式设置目标，保证交叉构建不会受到 runner 默认平台影响。
  $env:GOOS = $effectiveTargetOS
  $env:GOARCH = $effectiveTargetArch
  Remove-Item Env:LOCAL_GALLERY_VERSION -ErrorAction SilentlyContinue
  if (-not [string]::IsNullOrWhiteSpace($Version)) {
    $env:LOCAL_GALLERY_VERSION = $Version
  }

  if (-not $SkipFrontend) {
    Write-Host "[1/2] 构建前端（$effectiveTargetOS/$effectiveTargetArch）..." -ForegroundColor Cyan
    if (-not $SkipInstall) {
      Invoke-CheckedCommand "npm" @("ci") $frontendRoot
    }
    Invoke-CheckedCommand "npm" @("run", "build") $frontendRoot
  } else {
    Write-Host "[1/2] 跳过前端构建，复用 frontend/dist..." -ForegroundColor DarkGray
  }

  $ldflags = "-s -w"
  if (-not [string]::IsNullOrWhiteSpace($Version)) {
    $ldflags += " -X github.com/tianlongxiang/local-gallery/internal/config.Version=$Version"
  }
  Write-Host "[2/2] 构建后端（$effectiveTargetOS/$effectiveTargetArch）..." -ForegroundColor Cyan
  Invoke-CheckedCommand "go" @(
    "build",
    "-trimpath",
    "-ldflags=$ldflags",
    "-o",
    $serverPath,
    "./cmd/server"
  ) $backendRoot

  Write-Host "构建完成：$serverPath" -ForegroundColor Green
} finally {
  if ($null -eq $oldGoOS) {
    Remove-Item Env:GOOS -ErrorAction SilentlyContinue
  } else {
    $env:GOOS = $oldGoOS
  }
  if ($null -eq $oldGoArch) {
    Remove-Item Env:GOARCH -ErrorAction SilentlyContinue
  } else {
    $env:GOARCH = $oldGoArch
  }
  if ($null -eq $oldCgoEnabled) {
    Remove-Item Env:CGO_ENABLED -ErrorAction SilentlyContinue
  } else {
    $env:CGO_ENABLED = $oldCgoEnabled
  }
  if ($null -eq $oldAppVersion) {
    Remove-Item Env:LOCAL_GALLERY_VERSION -ErrorAction SilentlyContinue
  } else {
    $env:LOCAL_GALLERY_VERSION = $oldAppVersion
  }
}
