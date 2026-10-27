# 语音音色页面说明

本增强包为 WeChatAgent 控制台新增「语音音色」页面（`#voice`），严格沿用官方控制台的卡片、表单与按钮样式。

## 功能

### 1. 换音色（快速表单）
- 「目标聊天」下拉：列出所有已允许的好友与群聊
- 「音色 ID」输入框：填 Fish Audio 音色的 32 位十六进制引用 ID，留空表示跟随全局默认
- 「应用」：保存该聊天的专属音色
- 「先试听」：用当前输入的音色合成一段试听

### 2. 合成语音并发送
- 文本域输入要说的话（最多 300 字，实时字数统计）
- 「发送给」：选择目标聊天
- 「音色 ID」：可留空，使用该聊天已保存的音色
- 「合成并发送」：合成 SILK 语音条并通过原生发送器发给微信
- 「先试听」：合成但不发送

发送的目标标识会自动解析：
- 私聊数字 ID → 真实 wxid（通过 reader `/api/v1/sessions`）
- 群聊数字 ID → 群用户名 `xxxxx@chatroom`（同上）

### 3. 按聊天设置音色（表格）
- 每行：聊天 / 状态（专属或跟随默认）/ 音色 ID 输入框 / 引擎 / 当前生效 / 试听·恢复默认
- 「保存全部」：批量保存所有行的音色

### 4. 全局默认音色
- 未单独设置音色的聊天使用它
- 修改后立即生效，不用重启

### 5. 最近发送
- 展示本页面发出的语音发送记录（成功/失败、发送给、引擎、音色、时长、时间）
- 日志文件：`<workspace>\state\logs\voice-send.log`

## 数据文件

- 聊天音色：`<workspace>\state\voice\chats.json`
- 全局配置：`<workspace>\state\voice\config.json`
- 试听文件：`<workspace>\state\voice\preview\`
- 发送产物：`<workspace>\state\voice\outgoing\`

## 接口

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/voice` | GET | 读取默认配置、各聊天音色、路由状态 |
| `/api/voice/logs` | GET | 最近发送日志 |
| `/api/voice/chat` | POST | 保存/清除某个聊天的音色 |
| `/api/voice/default` | POST | 保存全局默认音色 |
| `/api/voice/preview` | POST | 合成试听音频，返回可播放 URL |
| `/api/voice/send` | POST | 合成并发送语音条 |
| `/voice-preview/<hash>.wav` | GET | 播放试听音频 |

## 发送链路

1. `synthesize()`（`packages/dsh-wechat-voice/lib/tts.mjs`）合成 WAV
2. `encodeSilk()`（`lib/silk.mjs`）用 `state/silk/bin/silk_encoder.exe` 转 SILK
3. `resolveTarget()`（`lib/wechat.mjs`）把数字 ID 解析成真实 wxid / chatroom 用户名
4. `sendVoice()` 调 hook 的 `/SendVoiceMsg`，文件必须位于 `state/voice/outgoing`

## 注意事项

- 音色 ID 失效时（Fish Audio 返回 `Reference not found`），试听会自动回退到 Edge 语音并提示原因；发送则明确报错。
- 请确保全局默认音色 ID 有效，否则没有专属音色的聊天会发送失败。
- 微信 hook 必须支持语音路由（`nativeVoiceSend: true`），即已部署带语音的 `version.dll`。