# dsh-wechat-voice —— 让鲸鲸在微信里开口说话

WeChatAgent 的语音插件：把一段文字在本机合成为语音，并且**只在原生发送器真能发语音时才发**。
它是 DSH 插件（`packages/dsh-wechat-voice`），提供四个工具，按聊天授权，跟 `send_meme` 那套工具同一套权限模型。

> 现状（2026-10-24，微信 4.1.10.27）：**真语音条已打通并实测**。插件默认用自然女声
> （Edge 神经网络语音优先，不可用时改用百度在线语音）合成 WAV，再用官方 SILK SDK 编成
> 微信磁盘格式，交给原生 hook 的 `/SendVoiceMsg` 构造 type 34 消息；两条在线通道都不可用时
> 自动回退本机 SAPI。「文件传输助手」里已经出现过绿色语音条（2 秒、6 秒各一条），点开能播。
>
> **隐私提示**：`engine: "auto"` / `"edge"` / `"baidu"` / `"fish"` 会把要朗读的文字发给在线语音服务
> （Edge、百度或 Fish Audio）；不想让文字离开本机就设 `"engine": "sapi"`（音色会回到 Windows 自带的机械声）。
>
> 两条通道都在：
>
> - **语音条通道（主路）**：绿色语音气泡，时长 1–60 秒；`mode: "voice"` 只在原生发送器接受后出现。
> - **文件通道（后备）**：hook 的 `/SendFileMsg` 把音频当**文件**发出，对方点开就能听。
>   是文件卡片，不是绿色语音条；只在语音路由不可用时自动降级。
>
> 两条都不可用时，语音只生成并停在 `state/voice/outgoing/`，本机可试听。

## 装上

```powershell
$env:DSH_HOME = 'D:\yu\dsh'   # 本机 DSH 的 home；默认是 %USERPROFILE%\.dsh
Push-Location D:\yu\workspace\packages\dsh-wechat-voice
npm install                    # ws + mpg123-decoder（在线语音与 MP3→WAV 解码）
Pop-Location
node D:\yu\workspace\packages\dsh-wechat-voice\scripts\install.mjs
```

它会：写 profile 的 `package.json` 依赖（`link:` 指向本项目）、追加 `cordis.yml` 条目、在
`node_modules` 建一个 junction。原文件都留了 `.bak-wechat-voice-<时间戳>` 备份，`--uninstall` 可原样撤回。
之后**从托盘完整退出 DSH 再打开**（插件在启动时加载）。

> 真语音条还要求两件本机资产：微信目录里注入带 `/SendVoiceMsg` 的 `version.dll`
> （`/WeChatAgent/health` 的 `nativeVoiceSend` 为 `true`），以及
> `state/silk/bin/silk_encoder.exe`。两者都已在本机就位；换机时照
> [语音条逆向笔记](../../docs/VOICE_BUBBLE_RE.md) 的「复现」一节做。
> 改完插件代码也要重启 DSH 才会加载新模块。

再给聊天授权：WeChatAgent → 聊天范围 → 选聊天 → 技能与工具 → 勾上 `wechat_voice_say` /
`wechat_voice_set` / `wechat_voice_preview` → 保存此会话。未授权时工具根本不会进入该聊天的工具列表，
即使被调用也会被插件自己拒绝（`TOOL_NOT_GRANTED`）。

## 试听（不发给任何人）

```powershell
$node = 'D:\yu\dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node D:\yu\workspace\packages\dsh-wechat-voice\scripts\preview.mjs "主人，我是鲸鲸。" --play
& $node D:\yu\workspace\packages\dsh-wechat-voice\scripts\preview.mjs "听听百度女声" --engine baidu --play
& $node D:\yu\workspace\packages\dsh-wechat-voice\scripts\preview.mjs "换晓伊试试" --engine edge --voice zh-CN-XiaoyiNeural
& $node D:\yu\workspace\packages\dsh-wechat-voice\scripts\preview.mjs "离线机械声" --engine sapi
& $node D:\yu\workspace\packages\dsh-wechat-voice\scripts\preview.mjs --status   # 体检
```

## 四个工具

| 工具 | 作用 |
| --- | --- |
| `wechat_voice_say` | 合成并发到当前聊天。参数 `text`、可选 `voice` `engine` `rate` `volume` `maxVoices`（`voice` 只影响这一条，不保存）。 |
| `wechat_voice_set` | **换音色并记住**。参数 `voice` `engine` `rate` `volume` `scope`；`scope: "chat"`（默认）只改当前聊天，`"global"` 改全局默认；`voice: ""` 清掉本聊天的专属音色。 |
| `wechat_voice_preview` | 只在本机合成，不发送；默认用当前聊天已保存的音色，可再用 `engine` / `voice` 临时覆盖。 |
| `wechat_voice_status` | 只读体检：当前引擎与音色、各聊天已保存的专属音色、Edge 可选音色、百度兜底、本机 SAPI 语音、hook 身份与版本、`/SendVoiceMsg` 是否可用、待发队列。 |

返回里的 `mode` 是硬的：`voice` 只会在原生发送器真的接受之后出现；原生语音路由不可用时自动降级为
`file`（文件卡片），连文件通道也没有时是 `staged` 并给出原因。**绝不伪报已发**。

## 换音色（自定义）

主人只要在微信里说一句「换成晓伊的声音」，agent 调 `wechat_voice_set` 就换好了，**下一条语音立即生效，
不用重启 DSH**：

```
wechat_voice_set({ voice: "晓伊" })                 # 这个聊天以后都用晓伊
wechat_voice_set({ voice: "晓北", rate: -2 })        # 东北女声，语速慢两档
wechat_voice_set({ voice: "晓伊", scope: "global" }) # 所有聊天共用
wechat_voice_set({ voice: "" })                     # 清掉本聊天音色，回到全局默认
```

- **优先级**：单次调用的 `voice` > 这个聊天保存的音色 > 全局默认（`state/voice/config.json`）。
- **中文短名**能直接用：晓晓 / 晓伊 / 云希 / 云扬 / 云夏 / 晓双 / 晓北 / 晓妮 / 曉曼 / 曉臻；
  也可以写 Edge 完整名（任何 `*Neural`）或本机已装的 SAPI 名。
- **引擎会跟着音色走**：选 Edge 音色时当前引擎是 `sapi`/`baidu`，会自动改成 `auto`（否则听不到在线音色）；
  选 SAPI 音色会自动改成 `sapi`。
- **名字必须真实存在**：认不出的音色返回 `CHAT_VOICE_UNKNOWN`，不会悄悄退成晓晓。
- **存哪里**：聊天专属音色写在 `state/voice/chats.json`（`{ "wechat:private:1769324077": { "edgeVoice": "zh-CN-XiaoyiNeural" } }`），
  全局默认仍在 `state/voice/config.json`。两者都是普通 JSON，手改也行，存盘即生效。

之前攒下的待发语音用这条命令补发：

```powershell
& $node D:\yu\workspace\packages\dsh-wechat-voice\scripts\send-pending.mjs --check    # 看积压和路由
& $node D:\yu\workspace\packages\dsh-wechat-voice\scripts\send-pending.mjs --dry-run  # 演练
& $node D:\yu\workspace\packages\dsh-wechat-voice\scripts\send-pending.mjs --limit 5  # 真发前 5 条
```

补发前会重新校验聊天白名单与授权；路由不存在时整轮直接退出，不会把普通文字顶替成语音发出。

## 合成与规格

- **首选：Edge 神经网络语音**（在线）。和 Edge 浏览器的「大声朗读」同一个后端，不需要 Azure key。
  默认 `zh-CN-XiaoxiaoNeural`（晓晓，温暖自然）；可换 `zh-CN-XiaoyiNeural`（晓伊，活泼少女）、
  `zh-CN-YunxiNeural`（云希，年轻男声）等任意 `*Neural` 音色。常用的十三个音色写在
  `EDGE_VOICES`（`lib/edge.mjs`）里，带中文标签，`wechat_voice_status` 的 `tts.edgeVoices`
  会列出来；中文短名（`晓伊`）由 `resolveEdgeVoice()` 换成真正的 id，认不出就报错而不是静默兜底。
  实现走 Edge 的 WebSocket 协议（`lib/edge.mjs`，依赖 `ws`）。服务会校验完整的
  浏览器指纹：除 UA/Origin 外还必须带 `Pragma`、`Cache-Control`、`Accept-Encoding`、
  `Accept-Language`，少一项会被回一个空 `200`；这些头已按本机 Edge 156 发送。
- **次选：百度在线女声**（在线）。Edge 连不上、超时或被服务端拒绝时，`engine: "auto"` 自动改用
  百度翻译的免 key 语音接口。音色固定为一种自然普通话女声，`spd` 与插件的 `rate` 对应；
  文字同样会离开本机。
- **最后兜底：Windows SAPI（离线）**。两条在线通道都失败时才用，返回里会给出 `voiceNote`，
  不会因为断网把语音条整条弄丢。Edge 连续失败后冷却 2 分钟，期间 `auto` 直接走百度，避免每条语音
  都卡一次连接超时。SAPI 优先用 PowerShell 7 的 `pwsh`（能看到 OneCore 语音
  `Microsoft Yaoyao`、`Kangkang`…）；没有就退到 5.1 的 `Microsoft Huihui Desktop`。
  配的 SAPI 语音不存在时自动降级并回报 `voiceNote`。插件跑在 DSH host 进程里，PATH 里通常没有
  `pwsh`，所以还会去 `<profile>/node_modules/@dsh-ops/pwsh-*/bin/pwsh.exe` 找
  （`DSH_VOICE_PWSH` 可覆盖）；`wechat_voice_status` 的 `tts.shell` 会告诉你实际用的是哪个。
- **可选：Fish Audio（在线，按量计费）**。`engine: "fish"` 时走
  [Fish Audio](https://github.com/fishaudio/fish-speech) 的 `POST /v1/tts`（默认模型 `s2-pro`，
  可切 `s2.1-pro` / `drama-3`）。它比 Edge/百度强在两点：支持 `[laughing]`、`[whisper]` 这类
  行内情绪标签，以及用 10–30 秒参考音频克隆音色（把 `voice` 设成 `reference_id` 即可）。
  需要 API key，见下面「Fish Audio」一节。**为什么不本机跑**：S2-Pro 权重 9.1 GB、Drama 3 权重
  39.6 GB，而这台机器是 8 GB 显存的 RTX 5060 Laptop（实际可用约 6.9 GB），装不下；
  `fishEndpoint` 指向自建 `tools/api_server.py` 也是同一条代码路径。
  `auto` 默认**不**走 Fish（付费），只有显式 `engine: "fish"` 或音色是 Fish `reference_id` 时才用。
- **解码**：两个在线服务都只回 MP3，统一用 WASM 版 mpg123（`mpg123-decoder`）解成 16-bit 单声道
  WAV（Edge 24 kHz、百度 16 kHz），再交给 SILK；结尾约 0.5 秒的房间底噪会被裁掉，只留 160 ms 自然尾音。
  Fish 回 MP3 也走同一条解码；自建服务器回 WAV 则直接归一化。
- **格式**：SAPI 直出 22050 Hz，在线引擎 24/16 kHz，统一是 16-bit PCM 单声道 WAV。发语音条前由
  `lib/silk.mjs` 归一成 16 kHz 单声道 PCM，再调官方编码器
  `state/silk/bin/silk_encoder.exe ... -tencent` 产出 `0x02 + "#!SILK_V3" + 帧流`；
  短于 1 秒补静音（微信自己的录音也拒绝 1 秒以下），超过 60 秒报 `SILK_TOO_LONG`。
  文件回退仍发原始 WAV。
- **语速/音量**：插件沿用 SAPI 的 `rate`（-10…10）和 `volume`（0…100）；Edge 换算成
  prosody 的 `-50%…+100%` 语速与相对音量，百度换算成 `spd` 3…7，所以同一个 `rate: 2`
  在三种引擎下听感接近。
- **切段**：微信语音上限 60 秒，按句号/换行打包，每段 ≤ 55 秒；单句超长时按逗号硬切。
  默认一次最多 2 段（`maxVoices`），超过就拒绝并提示缩短。
- **朗读前清洗**：去掉 Markdown、代码块、表情符号（含 `【表情: …】`/`[STICKER:…]` 标记）与链接
  （链接读作「一个链接」），零宽字符一并清掉。
- **缓存**：内容 + 音色 + 引擎 + 语速做键，同一句话只合成一次；`state/voice/index.json` 记账，
  默认最多 200 个、64 MiB，超出按最旧清理，**待发队列里的文件不删**。`auto/edge` 请求会忽略
  此前缓存的百度/SAPI 兜底音频，Edge 恢复后同一句话会自动用 Edge 重合成并覆盖缓存。
- **依赖**：`ws`（Edge WebSocket 客户端）和 `mpg123-decoder`（纯 WASM MP3 解码，无 ffmpeg、
  无原生编译）。`npm install` 后惰性加载；缺依赖时 `auto` 会继续往下退回 SAPI。

## 配置

配置的**持久位置**是 `<项目>/state/voice/config.json`（插件首次加载自动生成）：

```json
{ "engine": "auto", "edgeVoice": "zh-CN-XiaoxiaoNeural",
  "voice": "Microsoft Yaoyao", "rate": 0, "volume": 100,
  "maxVoices": 2, "maxChars": 500, "maxVoiceMs": 55000, "fallback": "stage",
  "fishApiKey": "", "fishApiKeyEnv": "FISH_AUDIO_API_KEY",
  "fishEndpoint": "", "fishProxy": "", "fishModel": "s2-pro",
  "fishLatency": "normal", "fishFallback": true }
```

`engine`：`auto`（Edge → 百度 → SAPI，默认）/ `edge`（只用 Edge，失败直接报错）/
`baidu`（只用百度在线女声）/ `sapi`（只用本机 SAPI，完全离线）/ `fish`（Fish Audio 在线合成）。
`edgeVoice` 是 Edge 音色；`voice` 是 SAPI 兜底音色（engine=fish 时它就是 Fish 的 `reference_id`）；
百度引擎只有一种女声，会忽略 `voice`。
改完存盘即可（下次发语音时重新读取，不用重启）；`engine` / `voice` / `rate` / `volume` 也能每次调用时用工具参数临时覆盖，
试音色不用重启 DSH。想让某个聊天单独用别的音色、又不想动全局默认，用 `wechat_voice_set`（写
`state/voice/chats.json`，见上文「换音色」）。`cordis.yml` 里的 `config:` 也认，但**DSH 重写 profile 时会剥离它不认识的字段**，
所以别把配置只写在 yml 里。注意 `cordis.yml` 的 `config:` 优先级高于 `config.json`，写在 yml 里的值会盖掉文件里的同名字段。

`fallback`：`stage`（路由缺失时只生成，默认）/ `text` / `error`（直接报错）。

### Fish Audio

Fish 是**显式选择**的引擎，`auto` 不会自动切过去（按量计费）。要启用：

1. 去 [fish.audio/auth/signup](https://fish.audio/auth/signup) 注册并验证邮箱；
2. 登录后打开 **<https://fish.audio/app/api-keys>**，点 **Create New Key**，起个名字（可设过期时间），
   复制生成的 key —— 只显示一次，存好；
3. 把 key 放进 `state/voice/config.json` 的 `fishApiKey`，或者设环境变量
   `FISH_AUDIO_API_KEY`（`fishApiKeyEnv` 可以改名）。**环境变量优先于文件里的空值**，
   不想让 key 落到磁盘上就用环境变量；
4. 把 `engine` 设成 `"fish"`（或只用一次：调用时传 `engine: "fish"`）。

> 想让主人先零成本试通，把 `fishModel` 设成 `"s2.1-pro-free"`——官方文档写明这一档是
> **$0**，用于开发测试，只是不保证延迟和数据处理协议。

| 字段 | 说明 |
| --- | --- |
| `fishApiKey` / `fishApiKeyEnv` | 直接写 key，或指向存放 key 的环境变量名（默认 `FISH_AUDIO_API_KEY`）。 |
| `fishEndpoint` | 留空 = 官方 `https://api.fish.audio/v1/tts`；自建 `tools/api_server.py` 时填它的 `/v1/tts` 地址。 |
| `fishProxy` | 走 HTTP 代理，如 `http://127.0.0.1:7890`（也接受裸 `127.0.0.1:7890`）。**国内必须配**，见下。 |
| `fishModel` | `s2.1-pro`（默认，官方推荐）/ `s2.1-pro-free`（**$0 免费档**，开发测试用）/ `s2-pro`（上一代）/ `drama-3`（剧本式，可精修）。模型走 `model` **请求头**，不在 URL 路径里。 |
| `fishLatency` | `normal` / `balanced`，官方 API 的首包延迟取舍。 |
| `fishFallback` | 默认 `true`：Fish 失败时回退 Edge→百度→SAPI，并在 `voiceNote` 里说明。设 `false` 则**直接报错**，不会静默换成别的音色。 |

克隆音色：在 fish.audio 上传 10–30 秒参考音频，拿到 `reference_id`（32 位），
填进 `voice`（或直接调用时传 `voice`）即可，`wechat_voice_set` 会自动把引擎切到 `fish`。
音色名在缓存键里，所以换 `reference_id` 不会命中旧音色的缓存。
`wechat_voice_status` 的 `tts.fish` 会显示模型、endpoint、`keyPresent`（只报有没有 key，不泄露内容）。

**网络**：`api.fish.audio` 在国内不可直连（DNS 会解析到 `104.244.46.21` 这类被污染地址，TCP 直接超时；
`fish.audio` 官网同样打不开）。所以要么配 `fishProxy`，要么把 `fishEndpoint` 指向可达的服务器。
`fishProxy` 是插件自己建 CONNECT 隧道（先 `CONNECT`，再在 socket 上做 TLS），不依赖 Node 的
`--use-env-proxy`——那样得重启宿主进程才生效。配好代理后用 `wechat_voice_preview` 试一句即可验证。

## 数据

```
state/voice/
  config.json                可编辑配置（持久，全局默认音色）
  chats.json                 每个聊天保存的专属音色（wechat_voice_set 写入）
  loaded.json                上次加载结果：{ok, reason, tools, settings}，排查用
  outgoing/<sha256>.wav      合成结果（内容寻址，同名即同一段音频）
  outgoing/<sha256>.silk     同目录的微信语音编码结果（发送时生成）
  index.json                 复用索引
  pending.json               原生路由缺失时攒下的待发语音（含聊天、时长、文本摘要）
```

`loaded.json` 是判断“插件到底加载没加载”的唯一凭据：`ok: true` 且带四个工具名 = 加载成功；
`reason: TOOLS_SERVICE_UNAVAILABLE` / `REGISTER_FAILED` = 没起来，原因就写在这里。

## 接通真语音：hook 契约

插件认两个契约，谁在就用谁，`voice` 优先于 `file`：

### `/SendFileMsg`（文件通道，已实现）

```
POST /SendFileMsg
Authorization: Bearer <state/hook/native-token.txt>
X-WeChatAgent-Account: <hook health 里的 databaseAccounts[0]>

{ "wxidorgid": "wxid_xxx", "path": "C:\\...\\state\\voice\\outgoing\\<sha>.wav" }

→ { "ret": 0, "retmsg": "accepted" }
```

原生实现 `scripts/native-hook/file_sender.cpp`：用 `FileFactory`（`0x1C4CE70`）建文件消息对象
（owner vtable `0x84F96B8`，就是媒体消息基类 `img_msg_vtbl`，签名与 `EmojiFactory` 同形），
补 receiver、`type=49` / `subtype=6`、本地路径、文件名、字节数六个字段，其余由微信自己的构造函数填好，
再交给 `send_message` 让客户端自己上传——和贴纸那条路一模一样。
路由只接受 `state/voice/outgoing/` 下的音频（`.wav/.mp3/.m4a/.ogg/.amr/.silk`，≤16 MiB），
不会成为任意文件的发送口子。`/WeChatAgent/health` 里的 `nativeFileSend` 表示这条通道是否就绪。

**实测记录（2026-10-22，微信 4.1.10.27）**：`type=49 subtype=6` 发到「文件传输助手」成功落地，
会话预览出现 `[文件] 398fefd4…`，客户端不崩、文件可点开播放。两个坑记一下：

- **微信按文件内容去重**：同一份 wav 短时间内重复发，后续几次会被静默丢弃（会话被唤起但不出消息）。
  判断成功要看会话列表预览的时间/文件名有没有更新，不能只看 HTTP 的 `ret:0`。
- 调试用 `/WeChatAgent/file-probe`：构造同样的消息对象但**不发送**，返回字段快照
  （owner/body vtable、type/subtype、各字符串长度、大小），改布局时不用重启微信。
- `/SendFileMsg` 也接受可选的 `type` / `subtype` 覆盖，方便试其它形态。

### `/SendVoiceMsg`（语音条通道，已实现并实测）

```
POST /SendVoiceMsg
Authorization: Bearer <state/hook/.../wechatagent-hook.token>
X-WeChatAgent-Account: <hook health 里的 databaseAccounts[0]>

{ "wxidorgid": "wxid_xxx",
  "path": "D:\\yu\\workspace\\state\\voice\\outgoing\\<sha>.silk",
  "duration": 5817, "format": "silk" }

→ { "ret": 0, "retmsg": "accepted",
    "fields": { "type": 34, "subtype": 0, "payloadLength": 15094,
                "storedDurationMs": 5817, "format": 12884901892,
                "maxDurationMs": 30000, "dispatched": true } }
```

原生实现 `scripts/native-hook/voice_sender.cpp`：

1. `VoiceFactory`（RVA `0x619A190`）构造 type 34 对象：owner/body vtable 校验，body = owner+0x10；
   target 写 `body+0xB0`，SILK 字节写 `body+0x708`（`std::string`），时长写 `body+0x728`，
   descriptor 写 `body+0x730`（`{format:4, channel:3, maxDurationMs:30000}`），最后 `body+0xD8=34`。
2. 与贴纸/文件同一条投递：`BuildSendParam1` + `BuildSendParam2_Image` + `send_message`。
3. 路径限定 `<root>/state/voice/outgoing/*.silk`，要求 10 B–16 MiB、首字节 `0x02`、magic `#!SILK_V3`、
   duration 1000–60000 ms；不是任意文件发送口。`/WeChatAgent/health` 的 `nativeVoiceSend` 表示布局就绪。
4. `/WeChatAgent/voice-probe` 只构造不发送，返回同一组字段，调布局时不用真发。

**实测（2026-10-23，微信 4.1.10.27）**：2 秒手工 SILK 与 5.8 秒 SAPI→SILK 各发一条到「文件传输助手」，
会话里都出现绿色语音条，点击有播放动效，`fields.type=34 / payloadLength` 与文件一致。两个坑：

- 微信对同一段音频会去重，连测时换文本或换音频。
- 原生 `ReadStagedSilk` 先做 `weakly_canonical` 再词法比较，路径必须是规范的单反斜杠或正斜杠；
  解出双反斜杠的 JSON（`D:\\yu\\...` 实际保留两个）会报 `Invalid SILK file`。插件用 `path.join`，没问题。

逆向细节、对象偏移与部署步骤都在 [语音条逆向笔记](../../docs/VOICE_BUBBLE_RE.md)。

## 排查

| 状态/错误 | 含义 |
| --- | --- |
| `HOOK_VOICE_ROUTE_MISSING` | hook 里没有 `/SendVoiceMsg`（旧 DLL）；自动降级为文件通道或 `staged` |
| `SILK_ENCODER_MISSING` | 找不到 `state/silk/bin/silk_encoder.exe`，语音条发不了；文件通道不受影响 |
| `SILK_TOO_LONG` | 单段音频超过 60 秒，微信语音条放不下 |
| `VOICE_SEND_REJECTED` | 原生发送器拒绝了参数（路径不在 `state/voice/outgoing`、SILK 头不对、时长越界） |
| `TOOL_NOT_GRANTED` | 该聊天没勾 `wechat_voice_say` |
| `CHAT_NOT_ALLOWED` | 聊天不在白名单 |
| `CHAT_UNRESOLVED` | 当前 DSH 会话没绑定微信聊天（例如普通 DSH 会话里调用） |
| `HOOK_NOT_LISTENING` / `HOOK_TOKEN_MISSING` | hook 没起来或 token 文件不在 |
| `TTS_VOICE_NOT_INSTALLED` | 配的 SAPI 语音本机没有，换 `Microsoft Yaoyao` / `Microsoft Huihui Desktop` |
| `TTS_EDGE_NETWORK` / `TTS_EDGE_TIMEOUT` | 连不上/超时 Edge 在线语音。`auto` 会改用百度；`edge` 模式直接报错 |
| `TTS_EDGE_VOICE` | Edge 音色名不对，换 `zh-CN-XiaoxiaoNeural` / `zh-CN-XiaoyiNeural` |
| `TTS_BAIDU_NETWORK` / `TTS_BAIDU_TIMEOUT` | 百度在线语音连不上/超时。`auto` 会再回退 SAPI；`baidu` 模式直接报错 |
| `TTS_BAIDU_EMPTY` / `TTS_BAIDU_DECODE_FAILED` | 百度返回空内容或解不出音频；`auto` 会再回退 SAPI |
| `TTS_EDGE_DEPENDENCY` / `TTS_BAIDU_DEPENDENCY` | 缺 `ws` 或 `mpg123-decoder`，在插件目录跑一次 `npm install` |
| `TTS_EDGE_DECODE_FAILED` / `TTS_EDGE_EMPTY` | Edge 返回的 MP3 解不出音频；`auto` 会改用百度 |
| `TTS_FISH_NO_KEY` | 没配 Fish 的 key：填 `fishApiKey` 或设 `FISH_AUDIO_API_KEY` |
| `TTS_FISH_AUTH` | Fish 拒绝了这个 key（401/403），检查是否有效/过期 |
| `TTS_FISH_QUOTA` | Fish 额度不够或被限流（402/429） |
| `TTS_FISH_NETWORK` / `TTS_FISH_TIMEOUT` | 连不上 Fish 或超时（`api.fish.audio` 在国内常需代理）；`fishFallback: true` 时会回退，`false` 时直接报错 |
| `TTS_FISH_MODEL` | 模型名不认识，换 `s2-pro` / `s2.1-pro` / `drama-3` |
| `TTS_FISH_EMPTY` / `TTS_FISH_DECODE_FAILED` | Fish 返回空内容或解不出音频 |
| `TTS_ENGINE_UNAVAILABLE` | 三条通道都不可用（例如断网且没装 SAPI 语音） |
| `VOICE_TOO_MANY_CHUNKS` | 内容太长，切出的段数超过 `maxVoices` |
| 插件卡片显示「异常」/未激活 | 注册阶段抛错了。看 `state/voice/loaded.json`：`reason: REGISTER_FAILED` 时 `error` 会写具体哪个关键字非法；`TOOLS_SERVICE_UNAVAILABLE` 表示 `tools` 服务没注入。 |
| 为什么 schema 会非法 | `ctx.tools.register()` 会对 `output.schema` 跑 `assertSupportedJsonSchema`，参数 schema 也受同一子集限制：只允许 `type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解。`type: 'json'` 是 `defineTool` 的 DSL，`maxLength/minimum/maximum` 也一律被拒——这类约束写进 `description`，实际钳制由服务端做。`test/schema.test.mjs` 会提前拦住这种写法。 |

## 测试

```powershell
$node = 'D:\yu\dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
Push-Location D:\yu\workspace\packages\dsh-wechat-voice
& $node --test "test/*.test.mjs"
```

91 个用例覆盖文本清洗、时长估算、60 秒切段、WAV 解析与 16 kHz 归一、SILK 头与时长、
短音频补 1 秒、缺编码器报错、缓存与配额、聊天授权、会话→wxid 解析、路由探测与拒绝伪报、
Edge SSML 转义/语速映射/静音裁剪/音色名校验、百度语速映射/URL 编码/入参校验，
以及一次真实 SAPI 合成（没引擎会自动 skip）。
Fish 用本地假服务器测（`test/fish.test.mjs`、`test/fish-proxy.test.mjs`）：URL/payload 形状、
`reference_id`、缺 key 直接拒绝、401/402/404/429/500 各自的错误码、非音频 200 报 `TTS_FISH_EMPTY`、
自建 WAV 响应归一化、连不上报网络错误；代理用**真的 CONNECT 代理**测，断言流量确实过了隧道，
还覆盖裸 `host:port`、拒绝 CONNECT、代理不可达。**不碰真实 `api.fish.audio`**，不需要 key 也不花钱。
SILK 测试会调用已构建的 `silk_encoder.exe` 编码临时 PCM，编码器不在时自动 skip。
在线语音请求不在自动测试里（合成真实样音属于人工验收）；测试全部跑在临时目录和假 hook 上，
不会向微信发任何消息。
`/WeChatAgent/voice-probe` 与「文件传输助手」的真发测试是人工验收，不放进自动测试。
