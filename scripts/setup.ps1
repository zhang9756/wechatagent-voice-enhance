<#
.SYNOPSIS
  WeChatAgent 语音音色增强包 - 一键完整安装

.DESCRIPTION
  自动完成以下步骤：
    1. 检测本机的 WeChatAgent 工作区与 DSH 安装位置
    2. 校验 WeChatAgent 版本为 0.4.1
    3. 安装语音后端组件：
       - 复制 dsh-wechat-voice 插件到 packages/，并注册到 DSH
       - 部署 silk_encoder.exe
       - 部署支持语音的 hook version.dll（nativeVoiceSend: true）
       - 生成 state/voice/config.json（Fish Audio 配置，需填 API Key）
    4. 打控制台「语音音色」页面补丁
    5. 重打社区桥接插件补丁
    6. 提示重开微信与重启 DSH

  用法：
    pwsh -File setup.ps1                      # 自动检测工作区
    pwsh -File setup.ps1 -Workspace D:\yu\workspace
    pwsh -File setup.ps1 -Workspace D:\yu\workspace -SkipCommunityPatch

  前提：
    - 已安装 WeChatAgent 0.4.1（含控制台与匹配微信客户端 4.1.10.27）
    - 微信客户端不在运行（脚本会在部署 hook 组件前检查）
#>
[CmdletBinding()]
param(
  [string]$Workspace = '',
  [switch]$SkipCommunityPatch,
  [switch]$SkipHookDeploy
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host ''
Write-Host '=================================================='
Write-Host ' WeChatAgent 语音音色增强包 · 一键完整安装'
Write-Host '=================================================='
Write-Host ''

# ---------- 1. 工作区检测 ----------
function Resolve-Workspace {
  param([string]$Path)
  if (-not [string]::IsNullOrWhiteSpace($Path)) {
    if (-not (Test-Path -LiteralPath (Join-Path $Path 'config\wechatagent.json'))) {
      throw "指定的工作区无效：$Path（缺少 config\wechatagent.json）"
    }
    return $Path
  }
  $candidates = @(
    (Join-Path $env:USERPROFILE 'WeChatAgent\workspace'),
    (Join-Path $env:USERPROFILE 'Documents\WeChatAgent\workspace'),
    'D:\yu\workspace'
  )
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath (Join-Path $c 'config\wechatagent.json')) {
      Write-Host "  [检测] 找到工作区：$c"
      return $c
    }
  }
  throw '未找到 WeChatAgent 工作区。请用 -Workspace 参数指定。'
}

$ws = Resolve-Workspace -Path $Workspace
Write-Host "  [工作区] $ws"

# ---------- 2. 版本校验 ----------
$distFile = Join-Path $ws 'config\distribution.json'
$version = ''
if (Test-Path -LiteralPath $distFile) {
  try { $version = (Get-Content $distFile -Raw | ConvertFrom-Json).version } catch {}
}
if ($version -notmatch '^0\.4\.1') {
  Write-Warning "检测到 WeChatAgent 版本：$($version -eq '' ? '未知' : $version)。"
  Write-Warning '本增强包基于 0.4.1 编写。请先升级到 WeChatAgent 0.4.1 再运行本脚本。'
  Write-Warning '升级后重跑：pwsh -File setup.ps1'
  exit 1
}
Write-Host "  [版本] WeChatAgent $version（匹配）"

# ---------- 3. 安装语音后端组件 ----------
Write-Host ''
Write-Host '-- 安装语音后端组件 --'

# 3.1 dsh-wechat-voice 插件
$srcPlugin = Join-Path $root 'vendor\dsh-wechat-voice'
$dstPlugin = Join-Path $ws 'packages\dsh-wechat-voice'
if (-not (Test-Path -LiteralPath (Join-Path $srcPlugin 'index.js'))) { throw "vendor 缺少 dsh-wechat-voice：$srcPlugin" }
New-Item -ItemType Directory -Path (Split-Path $dstPlugin -Parent) -Force | Out-Null
if (Test-Path -LiteralPath $dstPlugin) {
  $bakPlugin = Join-Path $ws ('state\console-backups\dsh-wechat-voice.' + (Get-Date -Format 'yyyyMMddHHmmss') + '.bak')
  New-Item -ItemType Directory -Path $bakPlugin -Force | Out-Null
  Copy-Item "$dstPlugin\*" $bakPlugin -Recurse -Force
}
Copy-Item "$srcPlugin\*" $dstPlugin -Recurse -Force
Write-Host "  [插件] dsh-wechat-voice -> $dstPlugin"

# 3.2 DSH 插件注册（junction）
$dshHome = ''
try {
  $dist = Get-Content $distFile -Raw | ConvertFrom-Json
  if ($dist.dshHome) { $dshHome = $dist.dshHome }
  elseif ($dist.dsh) { $dshHome = Split-Path $dist.dsh -Parent }
} catch {}
if (-not $dshHome -or -not (Test-Path -LiteralPath (Join-Path $dshHome 'profiles\desktop'))) {
  # 兜底：从环境推断
  $dshHome = $env:DSH_HOME
}
if ($dshHome -and (Test-Path -LiteralPath (Join-Path $dshHome 'profiles\desktop'))) {
  $link = Join-Path $dshHome 'profiles\desktop\node_modules\dsh-wechat-voice'
  New-Item -ItemType Directory -Path (Split-Path $link -Parent) -Force | Out-Null
  if (Test-Path -LiteralPath $link) {
    $it = Get-Item $link -Force
    if ($it.LinkType -ne 'Junction' -or $it.Target -ne $dstPlugin) {
      cmd /c rmdir "$link"
      cmd /c mklink /J "$link" "$dstPlugin"
      Write-Host "  [DSH] 重建插件链接 $link"
    } else {
      Write-Host "  [DSH] 插件链接已存在 $link"
    }
  } else {
    cmd /c mklink /J "$link" "$dstPlugin"
    Write-Host "  [DSH] 创建插件链接 $link"
  }
} else {
  Write-Warning "  [DSH] 未找到 DSH profiles\desktop，请在 DSH 中手动安装插件：$dstPlugin"
}

# 3.3 silk 编码器
$dstSilk = Join-Path $ws 'state\silk\bin'
New-Item -ItemType Directory -Path $dstSilk -Force | Out-Null
Copy-Item (Join-Path $root 'vendor\silk\silk_encoder.exe') (Join-Path $dstSilk 'silk_encoder.exe') -Force
Write-Host "  [SILK] silk_encoder.exe -> $dstSilk"

# 3.4 语音版 hook DLL
if (-not $SkipHookDeploy) {
  $nativeDir = Join-Path $ws 'state\hook\native'
  if (-not (Test-Path -LiteralPath $nativeDir)) { throw "缺少 hook native 目录：$nativeDir（请先通过 WeChatAgent 控制台完成微信连接配置）" }
  $dll = Join-Path $nativeDir 'version.dll'
  if (Test-Path -LiteralPath $dll) {
    Copy-Item $dll (Join-Path $nativeDir ("version.dll." + (Get-Date -Format 'yyyyMMddHHmmss') + '.bak')) -Force
  }
  Copy-Item (Join-Path $root 'vendor\hook\version.dll') $dll -Force
  Copy-Item (Join-Path $root 'vendor\hook\build.json') (Join-Path $nativeDir 'build.json') -Force
  Write-Host "  [HOOK] 语音版 version.dll 已部署到 $nativeDir（备份原文件）"
  Write-Host '         下次重开微信时，launch-hook-wechat 会把它部署到微信客户端并启用语音路由。'
} else {
  Write-Host "  [HOOK] 已跳过 hook 部署（-SkipHookDeploy）"
}

# 3.5 Fish Audio 配置
$voiceCfg = Join-Path $ws 'state\voice\config.json'
if (-not (Test-Path -LiteralPath $voiceCfg)) {
  New-Item -ItemType Directory -Path (Split-Path $voiceCfg -Parent) -Force | Out-Null
  Copy-Item (Join-Path $root 'vendor\voice.config.example.json') $voiceCfg -Force
  Write-Host "  [语音] 已生成 state\voice\config.json，请填入 Fish Audio API Key"
} else {
  Write-Host "  [语音] state\voice\config.json 已存在，跳过生成"
}

# ---------- 4. 控制台补丁 ----------
Write-Host ''
Write-Host '-- 打控制台补丁 --'
$apply = Join-Path $root 'scripts\apply-voice-patch.ps1'
if (-not (Test-Path -LiteralPath $apply)) { throw "缺少补丁脚本：$apply" }
$patchArgs = @('-Workspace', $ws)
if ($SkipCommunityPatch) { $patchArgs += '-SkipCommunityPatch' }
& pwsh -NoProfile -ExecutionPolicy Bypass -File $apply @patchArgs
if ($LASTEXITCODE -ne 0) { throw '控制台补丁执行失败，请查看上方日志。' }

# ---------- 5. 完成 ----------
Write-Host ''
Write-Host '=================================================='
Write-Host ' ✅ 完整安装已完成！'
Write-Host ''
Write-Host ' 接下来（按顺序）：'
Write-Host '  1. 填写 Fish Audio API Key：'
Write-Host "     编辑 $voiceCfg"
Write-Host '     在 fish.audio 注册账号 -> 控制台 -> API Keys 获取。'
Write-Host '  2. 重开微信（先完全退出再打开，或在控制台点「打开匹配微信」），'
Write-Host '     让语音版 version.dll 生效（nativeVoiceSend: true）。'
Write-Host '  3. 完整退出并重新打开 DSH（托盘退出）。'
Write-Host '  4. 打开 WeChatAgent 控制台 -> 侧边栏「语音音色」：'
Write-Host '     - 在「全局默认音色」填一个 Fish Audio 音色 ID'
Write-Host '     - 在「合成语音并发送」输入文字选聊天，直接发语音条'
Write-Host '=================================================='
Write-Host ''