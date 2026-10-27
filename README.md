# WeChatAgent 语音音色增强包

为 [WeChatAgent](https://github.com/sourcepro5/WeChatAgent)（微信远程助手）控制台新增 **「语音音色」图形页面**，让你：

- 按聊天单独设置 Fish Audio 音色（输入音色 ID 即可，不用翻 JSON）
- **输入文字 → 合成语音条 → 直接发送到指定微信聊天**
- 试听音色、查看发送历史、设置全局默认音色

页面严格沿用 WeChatAgent 官方控制台的卡片、表单、表格样式，升级后一键重打补丁即可恢复。

> ⭐ **v2.0 起为「完整安装包」**：已内置语音发送的全部后端组件——
> `dsh-wechat-voice` 插件、`silk_encoder.exe`、支持 `SendVoiceMsg` 的语音版 `version.dll`，
> 以及 Fish Audio 配置模板。运行 `setup.ps1` 即可全自动安装，无需手动准备组件。

---

## ✨ 功能一览

| 功能 | 说明 |
| --- | --- |
| 换音色 | 选聊天 → 填音色 ID → 应用，下一条语音立即生效 |
| 合成并发送 | 输入文字 → 选聊天/音色 → 合成语音条直接发给微信 |
| 先试听 | 发送前先本地合成试听，不打扰对方 |
| 按聊天设置 | 表格逐行管理每个聊天的音色与引擎 |
| 全局默认音色 | 未单独设置的聊天使用默认音色 |
| 最近发送 | 每次发送的成功/失败记录，含目标、引擎、时长 |
| 语音优先角色卡 | 附赠模板：让微信里的助手只用语音、发完语音不再补文字、群聊也优先语音 |

## 📁 目录结构

```
wechatagent-voice-enhance/
├── README.md
├── LICENSE
├── docs/
│   └── VOICE_PAGE.md          # 语音页面功能与接口说明
├── patch/                     # 补丁文件
│   ├── voice-settings.js      # 新增语音页面前端模块（完整文件）
│   ├── console.js            # 补丁后控制台主脚本
│   ├── console-server.mjs    # 补丁后控制台服务端（含 /api/voice*）
│   ├── index.html            # 补丁后控制台页面（含导航）
│   ├── layout-model.mjs      # 补丁后路由表
│   └── *.original            # 官方 0.4.1 原版，供核对
├── vendor/                    # 语音后端组件（v2.0 完整包）
│   ├── dsh-wechat-voice/      # 语音合成/发送插件（MIT）
│   ├── silk/silk_encoder.exe  # SILK 编码器
│   ├── hook/version.dll       # 语音版 hook（支持 SendVoiceMsg）
│   ├── hook/build.json        # hook 清单（sha256）
│   └── voice.config.example.json  # Fish Audio 配置模板
├── scripts/
│   ├── setup.ps1              # 一键安装（检测工作区→打补丁）
│   ├── apply-voice-patch.ps1 # 一键打补丁（校验→备份→覆盖）
│   └── repatch-community.ps1 # 社区桥接插件补丁（web_search 重名 / 历史写入）
├── roles/
│   └── voice-rules.md         # 语音优先角色卡规则模板
└── config/
    └── chats.example.json     # 聊天音色配置文件示例
```

## 🚀 安装

### 环境要求

- Windows 10/11
- 已安装 **WeChatAgent 0.4.1**（含控制台与匹配微信客户端 4.1.10.27）—— 本包补丁基于 0.4.1，0.4.0 需先升级
- 微信客户端未在运行（安装脚本会在部署 hook 组件时检查）
- 一个 **Fish Audio API Key**（`state/voice/config.json`，注册 fish.audio 后免费获取）

> 安装脚本会自动部署全部语音后端组件（dsh-wechat-voice 插件、SILK 编码器、语音版 hook DLL），
> 不需要你手动准备。v2.0 完整包无需再单独下载语音组件。

### 步骤

#### 方式一：一键完整安装（推荐）

1. 克隆或下载本项目，解压到任意目录。
2. 以 PowerShell 运行一键安装脚本：

```powershell
pwsh -File scripts\setup.ps1 -Workspace <你的工作区目录>
```

> 不带 `-Workspace` 时脚本会自动检测常见路径；找不到再手动指定。
> 脚本会自动：检测工作区并校验 0.4.1 → 部署语音后端（插件/SILK/hook DLL/配置模板）
> → 备份原文件 → 打控制台补丁 → 重打社区桥接插件补丁。
> 安装完成后按脚本提示：填 Fish Audio API Key → 重开微信 → 重启 DSH。

#### 方式二：手动打补丁

1. 克隆或下载本项目。
2. 以 PowerShell 运行一键补丁：

```powershell
pwsh -File scripts\apply-voice-patch.ps1 -Workspace <你的工作区目录>
```

> `-Workspace` 是你的 WeChatAgent 工作区目录（包含 `config\wechatagent.json`）。

3. 脚本会自动：
   - 备份所有将被覆盖的文件到 `state\console-backups\`
   - 部署补丁后的控制台文件
   - 重打社区桥接插件补丁（`model-search.mjs` / `dsh-access.mjs`）
4. **完整退出并重新打开 DSH**（托盘退出，不是关窗口），让插件重新加载。
5. 打开 WeChatAgent 控制台，侧边栏出现「语音音色」页面。

### 首次使用

1. 在「全局默认音色」填入一个有效的 Fish Audio 音色 ID（32 位十六进制）。
2. 在「按聊天设置」里为常用聊天填入音色 ID，点「保存全部」。
3. 在「合成语音并发送」输入文字、选聊天、点「合成并发送」。

## 🔄 升级后

WeChatAgent 每次重装/升级都会覆盖 `public\console\*` 与 `scripts\console-server.mjs`。
升级完成后**重跑一次补丁脚本**即可恢复语音页面，并确保社区补丁不丢失。

## ⚠️ 注意事项

- **音色 ID 有效性**：Fish Audio 上被删除或私有的音色 ID 会返回 `Reference not found`。
  试听会自动回退 Edge 并提示原因；发送会明确报错。请保持全局默认音色有效。
- **隐私**：本项目不含任何真实账号、API Key、音色 ID 或聊天记录。请勿把
  `<workspace>\state`、`config\wechatagent.json` 等目录提交到 GitHub。
- **角色卡快照**：修改 `roles/*.md` 后，`state/bridge-config.json` 中对应快照必须同步，
  否则桥接会拒绝处理（`BEHAVIOR_CHANGE_NOT_ALLOWED`）。见 `roles/voice-rules.md`。
- **仅限自用**：本增强包用于个人微信自动化场景，请遵守微信平台与所在地法律法规，勿用于骚扰或违规用途。

## 📄 许可

MIT License，见 [LICENSE](LICENSE)。

WeChatAgent 本身为 [sourcepro5/WeChatAgent](https://github.com/sourcepro5/WeChatAgent) 项目。
本仓库仅包含增强补丁，不包含其源代码。上标 WeChat-Hook 相关源码请参见其上游 [aixed/WeChat-Hook](https://github.com/aixed/WeChat-Hook)。