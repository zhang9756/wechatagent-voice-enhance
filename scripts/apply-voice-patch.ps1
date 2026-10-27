<#
.SYNOPSIS
  WeChatAgent 语音音色增强包 - 一键打补丁

.DESCRIPTION
  为 WeChatAgent 0.4.1 控制台增加「语音音色」页面：
    - 按聊天单独设置 Fish Audio 音色 ID
    - 输入文字合成语音并发送到指定聊天
    - 试听、发送历史、全局默认音色
  并同步社区桥接插件补丁（model-search / dsh-access）。

  用法：
    pwsh -File apply-voice-patch.ps1 -Workspace <你的工作区目录>

  说明：
    - 打补丁前会自动备份原文件到 <workspace>\state\console-backups
    - 每次 WeChatAgent 升级（安装包重装）后需要重跑本脚本
    - 打完后必须【完整退出并重新打开 DSH】（托盘退出），补丁才生效
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Workspace,
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$SkipCommunityPatch,
  [switch]$Restore
)

$ErrorActionPreference = 'Stop'

function Backup-File([string]$File) {
  if (-not (Test-Path -LiteralPath $File)) { return }
  $dir = Join-Path $Workspace 'state\console-backups'
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $name = [IO.Path]::GetFileName($File)
  $dest = Join-Path $dir ("$name." + (Get-Date -Format 'yyyyMMddHHmmss') + '.bak')
  Copy-Item -LiteralPath $File -Destination $dest -Force
  Write-Host "  [备份] $dest"
}

function Get-Sha256([string]$File) {
  if (-not (Test-Path -LiteralPath $File)) { return '' }
  return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
}

$patchDir = Join-Path $ProjectRoot 'patch'

# 待应用的文件映射：项目内补丁文件 -> workspace 目标文件
$mapping = @(
  @{ Name = 'console.js';          Patch = Join-Path $patchDir 'console.js';          Target = Join-Path $Workspace 'public\console\console.js' }
  @{ Name = 'index.html';          Patch = Join-Path $patchDir 'index.html';          Target = Join-Path $Workspace 'public\console\index.html' }
  @{ Name = 'layout-model.mjs';    Patch = Join-Path $patchDir 'layout-model.mjs';    Target = Join-Path $Workspace 'public\console\layout-model.mjs' }
  @{ Name = 'voice-settings.js';   Patch = Join-Path $patchDir 'voice-settings.js';   Target = Join-Path $Workspace 'public\console\voice-settings.js' }
  @{ Name = 'console-server.mjs';  Patch = Join-Path $patchDir 'console-server.mjs'; Target = Join-Path $Workspace 'scripts\console-server.mjs' }
)

Write-Host ''
Write-Host '================ WeChatAgent 语音音色增强补丁 ================'
Write-Host "  工作区    : $Workspace"
Write-Host "  补丁目录  : $patchDir"
Write-Host ''

if (-not (Test-Path -LiteralPath $Workspace)) { throw "找不到工作区：$Workspace" }
if (-not (Test-Path -LiteralPath (Join-Path $Workspace 'config\wechatagent.json'))) {
  throw '该目录不是有效的 WeChatAgent 工作区（缺少 config\wechatagent.json）。'
}

if ($Restore) {
  Write-Host '-- 还原模式：从 state\console-backups 恢复最近的备份？'
  Write-Host '   请手动从备份目录恢复，脚本不自动覆盖。'
  exit 0
}

Write-Host '-- 应用控制台补丁 --'
foreach ($m in $mapping) {
  $name = $m.Name
  $patch = $m.Patch
  $target = $m.Target
  if (-not (Test-Path -LiteralPath $patch)) { throw "补丁文件缺失：$patch" }
  if (-not (Test-Path -LiteralPath $target)) {
    Write-Host "  [新增] $name（目标不存在，直接部署）"
    Backup-File $target
    Copy-Item -LiteralPath $patch -Destination $target -Force
    continue
  }
  Backup-File $target
  Copy-Item -LiteralPath $patch -Destination $target -Force
  $now = Get-Sha256 $target
  $expect = Get-Sha256 $patch
  if ($now -ne $expect) { throw "校验失败：$name 复制后哈希不一致" }
  Write-Host "  [更新] $name -> $(Split-Path $target -Leaf)（SHA256 校验通过）"
}

if (-not $SkipCommunityPatch) {
  Write-Host ''
  Write-Host '-- 社区桥接插件补丁（model-search / dsh-access）--'
  $repatch = Join-Path $ProjectRoot 'scripts\repatch-community.ps1'
  if (-not (Test-Path -LiteralPath $repatch)) { throw "缺少社区补丁脚本：$repatch" }
  & pwsh -NoProfile -ExecutionPolicy Bypass -File $repatch -Workspace $Workspace
  if ($LASTEXITCODE -ne 0) { throw '社区补丁脚本执行失败' }
}

Write-Host ''
Write-Host '================ 完成 ================'
Write-Host '下一步：'
Write-Host '  1. 打开 WeChatAgent 控制台，侧边栏会出现「语音音色」页面。'
Write-Host '  2. 进入控制台前，请先【完整退出并重新打开 DSH】（托盘退出），'
Write-Host '     确保新插件代码被 DSH 重新加载。'
Write-Host '  3. 首次使用请先在「全局默认音色」填一个有效的 Fish Audio 音色 ID。'
Write-Host '     音色 ID 是 fish.audio 上音色的 32 位十六进制引用 ID。'
Write-Host ''
Write-Host '升级提醒：WeChatAgent 每次重装升级都会覆盖这些文件，升级后重跑本脚本即可。'
