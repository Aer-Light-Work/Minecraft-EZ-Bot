# MC Bot Self

一个由 Pixi 固定运行环境的自托管 Mineflayer 多机器人项目。既可纯 CLI 运行，也可启用 React + TypeScript 控制台，在同一个 Web 管理端中创建、启动和控制多个机器人。

## 首次安装

不要调用系统 Node.js/npm；仓库的 `preinstall` 也会阻止非 Pixi 安装。

**PowerShell：**
```powershell
Copy-Item config/bots.example.json config/bots.local.json
Copy-Item config/whitelist.example.json config/whitelist.local.json
pixi run install
pixi run check
pixi run test
```

**Bash（Linux / macOS）：**
```bash
cp config/bots.example.json config/bots.local.json
cp config/whitelist.example.json config/whitelist.local.json
pixi run install
pixi run check
pixi run test
```

真实服务器地址、账号、玩家白名单和 Microsoft 登录缓存只会写入被 Git 忽略的 `config/*.local.json` 与 `data/auth/`。

## Pixi 命令

```shell
pixi run bot Musashi  # 启动一个机器人和交互式 CLI
pixi run bots         # 启动全部 enabled 机器人（无需 Web）
pixi run start        # 启动生产 API 和已构建 Web UI
pixi run dev          # 同时启动 API 与 Vite 开发服务器
pixi run check        # 检查后端语法和示例配置
pixi run test         # 运行聊天解析、配置持久化和 API 测试
pixi run build        # 类型检查并构建 React UI
```

生产 UI 默认位于 `http://127.0.0.1:3000`。`pixi run start` 不会强制启动机器人；只有 `web.autoStart` 中列出的机器人会自动连接。

## Web 管理

Web 控制台支持：

- 新增、编辑和删除机器人，并持久化到 `config/bots.local.json`；
- 单个启动、停止、重启以及全部启动/停止；
- 快捷操作、自由命令输入、状态、背包、附近玩家与最近日志；
- 直接编辑游戏内命令白名单；
- 为每个启用 Prismarine Viewer 的机器人自动分配独立端口。

控制 API/UI 只需要一个端口（默认 `3000`）。Minecraft 机器人是向服务器发起连接的客户端，不需要为每个机器人开放入站端口；只有第三方视角需要独立端口，默认从 `web.viewerPortStart`（`3101`）开始分配。Microsoft 首次登录的设备代码会出现在服务端控制台及 Web 日志中。

## 复合技能工作流

工作流把机器人能力拆成可复用节点，并通过 JSON 保存：`start`、`ensure_mining_home`、`has_usable_pickaxe`、`resupply`、`goto_home`、`equip`、`start_region_mining`、`stop_region_mining`、`wait`、`log` 和 `end`。分支节点可以使用 `true`、`false`、`error` 三种出口，因此"有镐子直接挖、没有镐子去补给点、补给失败进入错误收尾"可以被配置成一张图，而不是写死在一个超长函数里。

首次使用时复制示例配置：

**PowerShell：**
```powershell
Copy-Item config/workflows.example.json config/workflows.local.json
```

**Bash：**
```bash
cp config/workflows.example.json config/workflows.local.json
```

然后可以在 Web 控制台的"复合工作流"页面拖拽节点、配置参数、连线、导入/导出 JSON，并保存到本地工作流配置。CLI 或 Web API 也可以启动工作流：

```text
workflow run region-mining-safe
```

工作流文件和机器人配置一样可能包含服务器行为参数，真实运行配置只放在被 Git 忽略的 `config/workflows.local.json`，不要提交账号、服务器地址或权限信息。

## 统一命令

Web、CLI 和游戏聊天最终都调用同一套命令执行逻辑。现有命令包括 `status`、`stop`、`fish`、`kill on/off`、`home`、`sethome`、`come`、`follow` 和 `cmd`。

游戏内发送者必须存在于 `config/whitelist.local.json`。机器人目标可放在命令前或命令后，不区分大小写：

```text
Musashi_Chan come
come Musashi_Chan
kill on Musashi_Chan
status all
```

`come` 和 `follow` 在游戏聊天中默认以发命令的玩家为目标；Web/CLI 中则显式填写玩家名，例如 `come PlayerName`。

## 登录代理

每个机器人可以配置独立的 SOCKS5/HTTP 代理，仅用于 Microsoft/Mojang 登录鉴权的 HTTP(S) 请求。代理不会影响 Bot 与 Minecraft 服务器之间的原始 TCP 连接。

在 Bot 配置中添加 `authProxy` 字段（例如 `"authProxy": "socks5://127.0.0.1:1080"`），或在 Web 管理端的机器人编辑器中勾选"启用登录代理"并填入地址即可。

## 目录与安全

- `apps/server/src/core/`：机器人生命周期和统一命令。
- `apps/server/src/core/auth-proxy.js`：登录鉴权代理模块（SOCKS5/HTTP）。
- `apps/server/src/web/`：控制 API 与静态 UI 服务。
- `apps/web/`：React + TypeScript + Vite 前端。
- `config/*.example.json`：可提交模板；`*.local.json` 永不提交。
- `data/auth/`：Microsoft 登录缓存，永不提交。

Web API 当前没有内置用户认证，默认只监听 `127.0.0.1`。远程使用时应放在 VPN，或带认证和 TLS 的反向代理后；不要直接暴露控制端口和 Viewer 端口到公网。公开部署时保持 `web.allowRawCommands: false`。