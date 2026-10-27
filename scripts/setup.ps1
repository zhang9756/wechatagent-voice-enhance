<#
.SYNOPSIS
  WeChatAgent 语音音色增强包 - 一键安装

.DESCRIPTION
  自动完成以下步骤：
    1. 检测本机的 WeChatAgent 工作区
    2. 运行 apply-voice-patch.ps1 打上语音音色页面补丁
    3. 重打社区桥接插件补丁
    4. 提示重启 DSH

  用法：
    # 自动检测工作区并安装
    pwsh -File setup.ps1

    # 手动指定工作区
    pwsh -File setup.ps1 -Workspace D:\yu\workspace

  注意：
    - 需要已安装 WeChatAgent 0.4.1 并已部署支持语音的 hook。
    - 安装后必须【完整退出并重新打开 DSH】（托盘退出）才生效。
#>
[CmdletBinding()]
param(
  [string]$Workspace = '',
  [switch]$SkipCommunityPatch
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host ''
Write-Host '=================================================='
Write-Host ' WeChatAgent 语音音色增强包 · 一键安装'
Write-Host '=================================================='
Write-Host ''

# 1. 检测工作区
function Resolve-Workspace {
  param([string]$Path)
  if (-not [string]::IsNullOrWhiteSpace($Path)) {
    if (-not (Test-Path -LiteralPath (Join-Path $Path 'config\wechatagent.json'))) {
      throw "指定的工作区无效：$Path（缺少 config\wechatagent.json）"
    }
    return $Path
  }
  # 常见路径
  $candidates = @(
    (Join-Path $env:USERPROFILE 'WeChatAgent\workspace'),
    (Join-Path $env:USERPROFILE 'Documents\WeChatAgent\workspace'),
    'D:\yu\workspace',
    'C:\yu\workspace'
  )
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath (Join-Path $c 'config\wechatagent.json')) {
      Write-Host "  [检测] 找到工作区：$c"
      return $c
    }
  }
  # 从 distribution.json 推断
  $dist = Get-ChildItem 'D:\','C:\' -Filter 'config\distribution.json' -Recurse -Depth 3 -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\workspace\\config\\distribution\.json$' } |
    Select-Object -First 1
  if ($dist) {
    $ws = Split-Path (Split-Path $dist.FullName -Parent) -Parent
    if (Test-Path -LiteralPath (Join-Path $ws 'config\wechatagent.json')) {
      Write-Host "  [检测] 从 distribution.json 找到工作区：$ws"
      return $ws
    }
  }
  throw '未找到 WeChatAgent 工作区。请用 -Workspace 参数指定，例如：pwsh -File setup.ps1 -Workspace D:\yu\workspace'
}

$resolved = Resolve-Workspace -Path $Workspace
Write-Host "  [使用] 工作区：$resolved"
Write-Host ''

# 2. 调用补丁脚本
$apply = Join-Path $root 'scripts\apply-voice-patch.ps1'
if (-not (Test-Path -LiteralPath $apply)) { throw "缺少补丁脚本：$apply" }

$patchArgs = @('-Workspace', $resolved)
if ($SkipCommunityPatch) { $patchArgs += '-SkipCommunityPatch' }
& pwsh -NoProfile -ExecutionPolicy Bypass -File $apply @patchArgs
if ($LASTEXITCODE -ne 0) { throw '补丁脚本执行失败，请查看上方日志。' }

Write-Host ''
Write-Host '=================================================='
Write-Host ' ✅ 安装完成！'
Write-Host ''
Write-Host ' 最后一步（必做）：'
Write-Host '   请【完整退出并重新打开 DSH】（托盘退出，不是关窗口）。'
Write-Host ''
Write-Host ' 打开 WeChatAgent 控制台，侧边栏出现「语音音色」页面：'
Write-Host '   1. 在「全局默认音色」填入一个有效的 Fish Audio 音色 ID'
Write-Host '   2. 在「按聊天设置」为常用聊天填音色 ID'
Write-Host '   3. 在「合成语音并发送」输入文字，选聊天，直接发语音条'
Write-Host '=================================================='
Write-Host ''