---
name: wechat-voice
description: 在微信聊天里代主人发语音，或按主人要求换音色/语速。说了「发语音」「说句话给我听」「用语音回」，或者主人想换声音（「换成晓伊的声音」「声音慢一点」）时使用。
---

# 微信语音

聊天已经授权 `wechat_voice_say` 时，你可以把回复真的说出去：

```
wechat_voice_say({ text: "主人，晚安。今天也别熬太晚。" })
```

默认用自然女声：Edge 神经网络语音（`zh-CN-XiaoxiaoNeural`，听起来像真人）优先，连不上时
自动改用百度在线女声，两条都不通才回退本机 SAPI；返回里的 `voiceNote` 会说明实际用了哪个。
注意 `auto` / `edge` / `baidu` / `fish` 都会把文字发给在线语音服务，敏感的悄悄话可以用 `engine: "sapi"`。

## Fish Audio（情绪更强，可克隆）

想要更细腻的情绪（`[laughing]`、`[whisper]`、`[sigh]` 这类行内标签）或主人自己的克隆音色时，
用 `engine: "fish"`（Fish Audio 的 S2-Pro / Drama 3）。它**按量计费**，所以 `auto` 不会自动用它：

```
wechat_voice_say({ text: "[laughing]主人你终于回来了，我还以为你忘了我呢。", engine: "fish" })
wechat_voice_set({ voice: "<32 位 reference_id>" })   // 引擎会自动切到 fish
```

需要先配 API key（`state/voice/config.json` 的 `fishApiKey`，或环境变量 `FISH_AUDIO_API_KEY`）。
没配时会返回 `ok: false, code: "TTS_FISH_NO_KEY"`——这时告诉主人去配 key，或者用默认的 Edge 音色发。
`fishFallback: true`（默认）时 Fish 失败会自动回退 Edge/百度，`voiceNote` 里会说明。
Fish 的 `rate` 是通过自然语言指令实现的，不保证精确。

## 换音色（能记住）

主人说「换成晓伊的声音」「以后用晓北吧」「声音再慢一点」时，**先调 `wechat_voice_set` 保存，
再照常发语音**。保存后下一条就生效，不用重启，也不用每次传 `voice`：

```
wechat_voice_set({ voice: "晓伊" })              // 这个聊天以后都用晓伊
wechat_voice_set({ voice: "晓北", rate: -2 })     // 东北女声，语速慢两档
wechat_voice_set({ voice: "晓伊", scope: "global" }) // 所有聊天共用这个默认
wechat_voice_set({ voice: "" })                  // 清掉本聊天的专属音色，回到全局默认
```

`voice` 写中文短名就行，插件会换成真正的 Edge 名字：

| 写这个 | 实际音色 |
| --- | --- |
| `晓晓` | zh-CN-XiaoxiaoNeural · 温暖自然女声（默认） |
| `晓伊` | zh-CN-XiaoyiNeural · 活泼少女声 |
| `云希` / `云扬` / `云夏` | 年轻男声 / 新闻播音男声 / 少年声 |
| `晓双` | 童声 |
| `晓北` / `晓妮` | 东北女声 / 陕西女声 |
| `曉曼` / `曉臻` | 粤语女声 / 台湾女声 |

也可以直接写 Edge 完整名（任何 `*Neural` 名都行），或本机已装的 SAPI 名（会切到离线引擎）。
写错名字会返回 `ok: false, code: "CHAT_VOICE_UNKNOWN"`，不会悄悄换成别的音色——这时问主人
想要哪个，或者用 `wechat_voice_status` 看 `tts.edgeVoices` 里能选什么。

想让主人先听再定，用 `wechat_voice_preview`：它默认用这个聊天当前的音色合成，不发送。
只在这一次临时换音色，可以直接给 `wechat_voice_say` 传 `voice`（不保存）。

## 结果怎么看

工具会做三件事：把文字清洗成能朗读的稿子（去 Markdown、表情、链接）、按 60 秒上限切段、
再交给原生发送器。返回值里的 `mode` 很重要：

- `voice` —— 原生发送器接受了，微信里是绿色语音条。**是否已经送达仍要看服务器回执**，别把"已接受"说成"对方听见了"。
- `file` —— 原生语音路由不可用，音频降级成文件卡片发出：对方点开能听，但不是绿色语音条。
  可以说明是「发了一段录音文件」，别说成语音条。
- `staged` —— 语音路由和文件通道都不可用，音频只生成在本机。这时**用文字正常回**，可以顺口说一句
  「语音先录好了，等发送器支持就发」，但不要假装已经发出去了。
- `ok: false` —— 看 `code`：没授权（`TOOL_NOT_GRANTED`）、聊天不在白名单（`CHAT_NOT_ALLOWED`）、
  语音太长（`VOICE_TOO_MANY_CHUNKS`）。这些情况直接改用文字，不用向对方解释错误码。

## 什么时候用

适合：纯情绪短句、晚安/早安、撒娇、想被听见的一句话、主人明确要求语音、主人想换声音。
不适合：报数据、贴代码、长段落、带链接的内容、需要逐字看清的信息——这些继续打字。

`text` 写口语，别写书面语，也别塞 `（轻声）` 之类的舞台说明；一条 25 字以内最自然。
被切成两条时，内容要能自然断开。

想先听效果又不打扰对方，用 `wechat_voice_preview`。
