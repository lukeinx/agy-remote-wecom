# agy-remote-wecom

[![npm](https://img.shields.io/npm/v/agy-remote-wecom)](https://www.npmjs.com/package/agy-remote-wecom)
[![license](https://img.shields.io/npm/l/agy-remote-wecom)](LICENSE)

> Control local Antigravity (`agy`) CLI and background ACP sessions from WeCom (企业微信) on your phone: switch or resume sessions, send prompts and attachments, approve tool calls, switch models, and receive results. Docs and commands are in Chinese.

在手机企业微信里遥控本机 Antigravity (`agy`)：管理终端与后台会话、收发消息与附件、切换模型与权限模式、审批工具调用、取回产物。本机通过企微智能机器人长连接直连，无需公网服务器。

- **随时接着聊**：选择正在运行的终端或后台会话，或检索历史会话继续任务
- **远程开工**：在常用终端新开标签页或后台 `agy acp` 启动会话，支持文字、图片和文件
- **审批与回传**：需要授权的工具调用推送企微卡片确认，任务完成后自动回传结果与产物
- **不串会话**：引用某条推送回复即自动路由到对应会话，多个任务并行互不干扰
- **本机直连**：复用官方企微 WebSocket 长连接 SDK，凭证与数据仅保存在本机

## 要求

- **macOS**、**Node.js ≥ 22**、**Antigravity CLI (`agy`)**（已验证 1.5.9+）
- 一个专用的**企业微信智能机器人**（工作台 → 智能机器人 → 创建机器人 → **API 模式 → 使用长连接**，获取 `BotID` 与 `Secret`）。同一机器人仅允许一条长连接，请勿与其他程序共用

## 安装与绑定

**npm 全局安装（推荐）**

```sh
npm install -g agy-remote-wecom
agy-remote setup
```

安装时 `postinstall` 会生成默认配置 `~/.config/agy-remote-wecom/config.json` 并向 `agy` 注册生命周期 Hook 插件；如需跳过自动步骤，可设 `AGY_REMOTE_SKIP_POSTINSTALL=1`（或 `npm install -g --ignore-scripts agy-remote-wecom`），之后运行 `agy-remote setup` 同样会完成全部初始化。

**源码安装**

```sh
git clone https://github.com/lukeinx/agy-remote-wecom.git
cd agy-remote-wecom
npm ci --ignore-scripts
./bin/remote.mjs setup
```

`setup` 会引导填入 `BotID` 与 `Secret`（以 `0600` 权限写入本地配置）、安装 `agy` 插件、注册并启动 macOS `launchd` 服务，随后显示 6 位绑定码。在手机企微单聊机器人发送该绑定码即完成绑定，之后仅接受主人单聊消息。

**会话自动命名**：新会话默认按首条输入生成短标题并同步到终端标签页（运行中 `⠋` / 完成 `·` / 失败 `×`）。未配置外部 API Key 时自动使用零延迟本地规则提取；如需 AI 中文短标题，可在 `config.json` 的 `tabTitle` 中填入任意 OpenAI 兼容接口地址与 `$环境变量` API Key（纯 HTTP 无状态请求，不创建临时 `agy` 会话）。

## 手机上用

选中会话后直接发送文字、图片或文件即可对话。图片和文件可先发送，5 分钟内补发文字合并投递（单批最多 10 件、单件不超过 100 MiB）。尚未选中会话时，消息会暂存并弹卡片选择已有会话或直接新建，无需重发。引用某条推送消息回复会自动路由到对应会话。

| 缩写 | 中文命令 | 作用 |
|---|---|---|
| `ls` | `活跃会话` | 查看并切换正在运行的终端或后台会话 |
| `h` | `历史会话 [关键词]` | 检索并恢复 `agy` 历史会话 |
| `n` | `创建会话 [目录] [消息]` | 打开新终端标签页启动 `agy` |
| `nb` | `创建后台会话 [目录] [消息]` | 在 `agy acp` 后台启动新会话 |
| `model` | `模型 [关键词]` | 切换后台会话或支持注入终端的模型 |
| `think` | `思考强度 [low/medium/high]` | 切换当前模型支持的思考强度 |
| `mode` | `模式 [default/accept-edits/auto/plan]` | 切换后台会话权限模式（终端在电脑按 `Shift+Tab`） |
| `name` | `命名 [名称 \| auto \| off \| model <id>]` | 手动改名、重新生成标题、切换命名模型或关闭自动命名 |
| `cd` | `目录 [别名或路径]` | 切换新建会话的默认工作目录 |
| `compact` | `压缩 [说明]` | 压缩后台会话上下文（需当前 ACP 支持） |
| `art` | `产物` / `查看产物` | 查看或下载当前会话生成的文档/图片产物 |
| `recap` | `回顾` | 推送当前会话上一轮完整提问与最终回复 |
| `remote` / `mute` | `关注` / `取关` | 开启全部终端任务完成推送 / 静音电脑端发起的任务推送 |
| `usage` / `quota` | `用量` / `额度` | 按模型分组查看剩余额度与重置时间（`用量 刷新` 强制刷新） |
| `status` / `stop` / `restart` / `help` | `状态` / `停止` / `重启 [force]` / `帮助` | 查看状态与上下文占用、中断任务、重启服务、查看全部命令 |

中文命令与参数间需保留空格：`模型 high` 是命令，`模型high` 会作为普通消息发出。

## 电脑端配置与 CLI

所有配置集中在 `~/.config/agy-remote-wecom/config.json`（JSONC 格式，支持 `//` 注释，保存即热生效；完整字段见 [config.example.json](config.example.json)）。在 `agy` 对话框输入 `/remote` 也可直接唤出配置文件路径与命令提示（0 Token）。

| 命令 | 作用 |
|---|---|
| `agy-remote setup` | 交互式配置凭证、安装插件、启动服务并等待绑定 |
| `agy-remote config` / `agy-remote edit` | 查看生效配置 / 用系统编辑器打开 `config.json` 并自动校验 |
| `agy-remote status` / `agy-remote usage` | 查看守护进程与活跃会话状态 / 查询模型剩余额度 |
| `agy-remote bind` | 重新生成 6 位绑定码并更换绑定主人 |
| `agy-remote alias [别名] [目录 \| rm 别名]` | 管理目录别名，供手机「创建会话」「目录」使用 |
| `agy-remote name [名称 \| auto \| off \| model]` | 管理会话自动命名与标签标题 |
| `agy-remote start \| stop \| restart [force]` | 管理 macOS `launchd` 后台服务（`run` 可在前台运行） |
| `agy-remote install-plugin` / `agy-remote uninstall` | 安装或更新 `agy` 插件 / 停止服务并卸载插件 |

## 支持的终端

支持 **Ghostty、cmux、iTerm2、WezTerm、kitty、tmux、Terminal.app**。默认 `auto` 自动探测当前运行中的终端；屏幕锁定或无可用终端时可改为创建后台会话。

<details>
<summary>终端配置与投递支持</summary>

在 `config.json` 中设置 `terminal`，保存即生效：

| 终端 | `terminal` | 要求 | 空闲终端无焦点投递 |
|---|---|---|---|
| Ghostty | `ghostty` | ≥ 1.3，允许 macOS 自动化控制 | 支持（≥ 1.4） |
| cmux | `cmux` | `cmux ping` 可用 | 支持 |
| iTerm2 | `iterm` | 允许 macOS 自动化控制 | 支持 |
| WezTerm | `wezterm` | `wezterm cli list` 可用 | 支持 |
| kitty | `kitty` | 开启远控并填写 `kittySocket` | 支持 |
| tmux | `tmux` | ≥ 3.0，可用 `tmuxSession` 指定会话 | 支持 |
| Terminal.app | `terminal` | macOS 自带 | 仅运行中续跑，空闲时提示未投递 |

`auto` 自动选择，`none` 仅使用后台会话。

</details>

## 验证范围与边界

- 主要支持平台为 **macOS**；其他系统可通过 `agy-remote run` 前台运行，未声明完整支持。
- 仅接受已绑定主人的单聊消息；电脑休眠或断网期间离线。后台会话继承本机 `agy` 环境，具备读写文件与执行命令能力。
- 权限审批会自动遵循 `~/.gemini/antigravity-cli/settings.json` 中的 `toolPermission: "always-proceed"` 与 `permissions.allow`；其余需要确认的工具调用按 `remoteConfirm`（默认 `ask-then-allow`，超时 10 分钟）推送到手机。`agy` 内置 `ask_question` 暂不支持手机端卡片作答。
- 卸载前运行 `agy-remote uninstall` 停止服务并移除插件，再卸载 npm 包；配置与日志保留在 `~/.config/agy-remote-wecom/`，按需手动清理。

## 开发

```sh
git clone https://github.com/lukeinx/agy-remote-wecom.git
cd agy-remote-wecom
npm ci --ignore-scripts
npm run check
npm run check:public
agy plugin validate ./plugin
```

## 许可

MIT，见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。
