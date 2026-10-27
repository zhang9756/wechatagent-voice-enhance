# 重打 WeChatAgent 社区桥接插件补丁（每次升级后跑一次）
#
# 补丁 1 · model-search.mjs
#   DSH 内置了同名工具 web_search，插件又在会话里注册 web_search，
#   DSH 报 "tool \"web_search\" is already registered in this scope"，
#   结果所有微信聊天都建不起会话 → 微信里一个字都回不出来。
#
# 补丁 2 · dsh-access.mjs
#   retireDshSkillHistory 会在 turn 之外 append 一条 tool/result，
#   DSH 0.3.6+ 严格校验会话日志 → "tool/result is outside an open turn"，
#   整个聊天会话的存储被判损坏，同样导致不回复。
#
# 用法：pwsh -File .\repatch-wechatagent-websearch.ps1
# 打完补丁必须【完整退出并重新打开 DSH】（托盘退出，不是关窗口），否则不生效。

param(
  [Parameter(Mandatory = $true)]
  [string]$Workspace
)

$ErrorActionPreference = 'Stop'

$pluginDir = Join-Path $Workspace 'packages\dsh-social-bridge-plugin'
$modelFile = Join-Path $pluginDir 'model-search.mjs'
$accessFile = Join-Path $pluginDir 'dsh-access.mjs'
foreach ($f in @($modelFile, $accessFile)) {
  if (-not (Test-Path -LiteralPath $f)) { throw "找不到插件文件：$f" }
}

$version = 'unknown'
try {
  $version = (Get-Content -LiteralPath (Join-Path $Workspace 'config\distribution.json') -Raw | ConvertFrom-Json).version
} catch {}

$modelText = [IO.File]::ReadAllText($modelFile, [Text.UTF8Encoding]::new($false))
$accessText = [IO.File]::ReadAllText($accessFile, [Text.UTF8Encoding]::new($false))

$modelDone = $modelText.Contains('searchToolOwned')
$accessDone = $accessText.Contains('改为不改写历史')

if ($modelDone -and $accessDone) {
  Write-Host "[跳过] 两个补丁都已就位（WeChatAgent $version），不用重复打。"
  Write-Host '若微信仍不回复，请确认已经「完整退出并重新打开 DSH」。'
  exit 0
}

# ---------------- 补丁 1：web_search 重名 ----------------
if (-not $modelDone) {
  $needle1 = '  let definition;'
  $needle2 = 'definitions:()=>active()&&definition?[definition]:[]'
  $needle3 = '  const dispose=agentCtx.tools.register(definition);'
  foreach ($n in @($needle1, $needle2, $needle3)) {
    if (-not $modelText.Contains($n)) { throw "model-search.mjs 结构与预期不符（找不到：$n）。未做任何修改。" }
  }
  $bak = Join-Path $pluginDir ("model-search.mjs.bak-official-$version")
  if (-not (Test-Path -LiteralPath $bak)) {
    Copy-Item -LiteralPath $modelFile -Destination $bak
    Write-Host "[备份] $bak"
  }
  $nl = if ($modelText.Contains("`r`n")) { "`r`n" } else { "`n" }
  $modelText = $modelText.Replace($needle1, '  let definition, searchToolOwned = true;')
  $modelText = $modelText.Replace($needle2, 'definitions:()=>active()&&definition&&searchToolOwned?[definition]:[]')
  $patched = @(
    '  // DSH builds that already register a native `web_search` in the same scope win:',
    '  // reuse that tool instead of failing the whole social session with a duplicate name.',
    '  let dispose=()=>{};',
    '  try{dispose=agentCtx.tools.register(definition);}',
    "  catch(error){searchToolOwned=false;log('model_search reuses the DSH-native web_search tool: '+(error?.message??error));}"
  ) -join $nl
  $modelText = $modelText.Replace($needle3, $patched)
  [IO.File]::WriteAllText($modelFile, $modelText, [Text.UTF8Encoding]::new($false))
  Write-Host '[补丁] model-search.mjs（web_search 重名）已更新。'
}

# ---------------- 补丁 2：turn 外写 tool/result ----------------
if (-not $accessDone) {
  $pattern = '(?s)export function retireDshSkillHistory\(session,createUserMessage,allowed\)\{.*?\r?\n\}'
  if (-not [regex]::IsMatch($accessText, $pattern)) {
    throw 'dsh-access.mjs 里没找到可识别的 retireDshSkillHistory 函数，未做任何修改。'
  }
  $bak = Join-Path $pluginDir ("dsh-access.mjs.bak-official-$version")
  if (-not (Test-Path -LiteralPath $bak)) {
    Copy-Item -LiteralPath $accessFile -Destination $bak
    Write-Host "[备份] $bak"
  }
  $replacement = @(
    'export function retireDshSkillHistory(session,createUserMessage,allowed){',
    '  // DSH 0.3.6+ 会严格校验会话日志：在 turn 之外 append tool/result 会被判定为',
    '  // "tool/result is outside an open turn"，整个社交会话因此损坏、无法加载。',
    '  // 这里改为不改写历史：旧技能说明留在历史里无害，技能仍按当前授权单独加载。',
    '  return;',
    '}'
  ) -join "`n"
  $accessText = [regex]::Replace($accessText, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $replacement }, 1)
  [IO.File]::WriteAllText($accessFile, $accessText, [Text.UTF8Encoding]::new($false))
  Write-Host '[补丁] dsh-access.mjs（turn 外写事件）已更新。'
}

# ---------------- 语法检查 + 重算插件 revision ----------------
$runtimes = Join-Path (Split-Path -Parent $Workspace) 'runtimes'
$node = Get-ChildItem -LiteralPath $runtimes -Directory -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending |
  ForEach-Object { Join-Path $_.FullName 'node.exe' } |
  Where-Object { Test-Path -LiteralPath $_ } |
  Select-Object -First 1
if (-not $node) { throw '找不到 node.exe，请手动重启 WeChatAgent 让配置重新生成。' }

foreach ($f in @($modelFile, $accessFile)) {
  & $node --check $f
  if ($LASTEXITCODE -ne 0) { throw "语法检查失败：$f（可用同目录 .bak-official-$version 还原）" }
}

& $node (Join-Path $Workspace 'scripts\project-config.mjs')
if ($LASTEXITCODE -ne 0) { throw '配置重算失败。' }

$rev = Select-String -LiteralPath (Join-Path $pluginDir 'cordis.patch.yml') -Pattern 'native-context\.mjs\?wechatagent=([0-9a-f]+)' |
  ForEach-Object { $_.Matches[0].Groups[1].Value }
Write-Host "[完成] 插件 revision = $rev"
Write-Host '下一步：完整退出 DSH（托盘退出，进程里一个 DeepSeek Harness.exe 都别剩），再重新打开。'

