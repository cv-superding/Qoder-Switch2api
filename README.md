# Qoder-Switch2api

Qoder（**国内版 Qoder CN / 国际版 Qoder**）多账号切换 + OpenAI / Anthropic 兼容反代。

界面与架构参考 [WorkBuddy-Switch2api](https://github.com/cv-superding/WorkBuddy-Switch2api)，Qoder 协议参考
[qoder2api](https://github.com/jyao0708/qoder2api)（Go）与 [Qoder-Switch](https://github.com/70548887/Qoder-Switch)（Rust/Tauri），
并针对**国内 / 国际双版本**做了账号池、认证文件、进程与域名的完全隔离。

```
┌──────────────────────────────────────────────────────────────┐
│  WebUI (React + TS + Tailwind，:8787)                         │
│  账号管理 / 积分统计 / Token 统计 / API 反代 / 会话管理 / 设置   │
├──────────────────────────────────────────────────────────────┤
│  Node 服务端 (Express，:8787)                                  │
│  ├─ /api/*            WebUI 后端                              │
│  ├─ 账号池            加密存储 · 轮转 · 冷却 · 续期              │
│  ├─ 切换器            读写 Qoder 客户端登录态 + 重启进程          │
│  └─ 反代网关          国内版 :7891 · 国际版 :7892               │
│      POST /v1/chat/completions   OpenAI Chat（流式/非流式）     │
│      POST /v1/responses          OpenAI Responses（Codex CLI） │
│      POST /v1/messages           Anthropic Messages（Claude Code）│
│      GET  /v1/models · GET /healthz · GET /usage-stats        │
└──────────────────────────────────────────────────────────────┘
```

## 功能

| 模块 | 说明 |
|---|---|
| 双版本账号池 | 国内版（Qoder CN，`*.qoder.com.cn`）与国际版（Qoder，`*.qoder.sh` / `qoder.com`）账号、认证文件、进程、域名完全独立，账号页用标签页分开 |
| 账号添加 | ① OAuth 设备流登录（PKCE S256，自动打开浏览器 + 轮询授权）② 导入本机客户端登录态 ③ 手动添加 PAT / IDE token ④ 备份文件导入 |
| 备份与迁移 | 导出账号 JSON，可选包含完整登录态；导入后可直接用于反代，也可只迁移账号信息 |
| 账号切换 | 把目标账号写入 Qoder 客户端登录态（新版 `auth.v1.dat` / 旧版 `state.vscdb`）并重启客户端；切换前自动备份，四步进度反馈 |
| OpenAI / Anthropic 反代 | 账号池轮转（额度优先 + round-robin）、失败冷却 120s、401/403 自动续期换号、按档位独立监听 |
| 积分与签到 | Credits 额度 / 套餐 / 到期监控；campaigns 每日签到（批量 + 自动定时，幂等） |
| Token 统计 | 请求数、输入/输出 Token 趋势图（Recharts），按账号 / 模型 / API 分布，落盘可查 |
| 会话管理 | 发现本机工作区与聊天历史（`lingma.chat.localHistory.*`），导出 JSON / Markdown |
| 安全 | 账号库 AES-256-GCM 加密存储（机器密钥派生）；客户端 OSCrypt 密钥仅在本机经 DPAPI 解出，不出内存 |

## 快速开始

提供两种运行方式，**功能完全一致**（同一套 React 前端 + 同一套业务逻辑）：

### 方式一：Node 服务模式（无需 Rust，开箱即用）

```bash
# 环境要求：Node.js >= 22.5（使用内置 node:sqlite 读取客户端数据库）
npm install
npm run dev        # 开发模式（前端 5173 + 后端 8787）
npm run build      # 生产构建
npm start          # 单端口托管前端 + API + 反代 → http://127.0.0.1:8787
```

也可以直接从 [Releases](https://github.com/cv-superding/Qoder-Switch2api/releases) 下载 Windows
可执行文件：`qoder-switch2api.exe`（桌面窗口）或 `qoder-server.exe`（仅本地服务）。

### 方式二：Tauri 桌面模式（Rust 后端，同参考项目 WorkBuddy-Switch2api 形态）

```bash
# 环境要求：Rust 工具链（rustup 安装）+ Node.js >= 22.5
#   Windows 需要 MSVC 链接器（Visual Studio Build Tools 的 C++ 工作负载），
#   或使用 windows-gnu 工具链（rustup toolchain install stable-x86_64-pc-windows-gnu）
npm install
npm run desktop:dev    # 开发模式（Vite 5173 + Tauri 窗口，热重载）
npm run desktop:build  # 产出安装包（src-tauri/target/release/bundle/nsis|msi）
```

Rust 版内置同一 Web 服务（127.0.0.1:8787，/api/* + 嵌入式前端），反代与 Node 版行为一致。

### 使用步骤

1. **账号管理** → 「OAuth 登录」或「导入本机账号」（自动读取本机 Qoder CN 客户端登录态）
2. **API 反代** → 打开「启用国内版接口」，监听地址默认 `127.0.0.1:7891`
3. 客户端接入：`http://127.0.0.1:7891/v1`（OpenAI 兼容）；Codex CLI 用 `/v1/responses`；Claude Code CLI 设 `ANTHROPIC_BASE_URL=http://127.0.0.1:7891`

反代端口可在页面修改；API Key 可留空（任意 Key 可用）或设置后要求 `Authorization: Bearer <key>`。
监听端口被占用时，反代页会直接显示失败原因，修改端口后保存即可重试。

## 目录结构

```
├── src-tauri/                # Tauri Rust 壳层（桌面模式）
│   ├── src/
│   │   ├── main.rs / lib.rs  # 入口：Web 服务 + 反代调度 + 自动签到
│   │   ├── editions.rs       # 国内/国际档位定义（端点、目录、进程名）
│   │   ├── paths.rs          # 数据目录与客户端路径解析
│   │   ├── crypto.rs         # AES-GCM（账号库）+ OSCrypt/DPAPI（客户端登录态）
│   │   ├── store.rs          # JSON 加密持久化（原子写）
│   │   ├── switcher.rs       # 客户端账号切换（备份→杀进程→写凭证→重启）
│   │   ├── sessions.rs       # 工作区/聊天历史发现与导出
│   │   ├── qoder/            # cosy.rs / chat.rs / oauth.rs / account.rs / info.rs
│   │   ├── proxy/            # gateway.rs（OpenAI/Anthropic 网关）+ usage.rs
│   │   ├── api.rs            # WebUI REST API
│   │   └── state.rs          # 共享状态
│   ├── icons/                # 应用图标（npm run icon 重新生成）
│   └── tauri.conf.json
├── server/                  # Node 后端（ESM，服务模式）
│   ├── index.js             # 入口：Web 服务 + 反代调度 + 自动签到
│   ├── editions.js          # 国内/国际档位定义（端点、目录、进程名）
│   ├── paths.js             # 数据目录与客户端路径解析
│   ├── crypto.js            # AES-GCM（账号库）+ OSCrypt/DPAPI（客户端登录态）
│   ├── store.js             # JSON 加密持久化（原子写）
│   ├── switcher.js          # 客户端账号切换（备份→杀进程→写凭证→重启）
│   ├── sessions.js          # 工作区/聊天历史发现与导出
│   ├── qoder/
│   │   ├── cosy.js          # Cosy 签名协议（AES-128-CBC + RSA + MD5 + 自定义 base64）
│   │   ├── chat.js          # 双后端：legacy SSE 流式 + Cloud Agents PAT
│   │   ├── oauth.js         # OAuth 设备流（登录/轮询/续期）
│   │   ├── account.js       # 账号池（轮转/冷却/分组/续期）
│   │   └── info.js          # 额度/套餐/签到/模型列表
│   ├── proxy/
│   │   ├── gateway.js       # OpenAI/Anthropic 兼容网关（每档位一实例）
│   │   └── usage.js         # 用量统计
│   └── routes/api.js        # WebUI REST API
├── src/                     # React 前端
│   ├── App.tsx              # 布局 + 路由（左侧导航，双版本入口）
│   ├── pages/               # 账号/反代/Token/积分/会话/设置
│   ├── components/          # 账号卡片、OAuth/切换/添加/备份对话框
│   └── lib/                 # API 客户端、类型、主题
├── docs/API-PROXY.md        # Qoder 协议与反代实现细节
└── scripts/smoke-ssr.mjs    # SSR 冒烟测试（npm run smoke）
```

## 数据与凭证存放

| 数据 | 位置 |
|---|---|
| 账号库（加密） | `~/.qoder-switch/accounts.json` |
| 反代配置 / 设置 | `~/.qoder-switch/settings.json` |
| 用量统计 / 签到日志 | `~/.qoder-switch/usage.json` / `checkin.jsonl` |
| 会话导出 | `~/.qoder-switch/exports/` |
| Qoder CN 客户端登录态 | `%APPDATA%/com.qodercn.app.stable/auth.v1.dat`（或 `QoderCN` / `Qoder CN`） |
| Qoder 国际版客户端登录态 | `%APPDATA%/Qoder/auth.v1.dat` |

> 账号凭证等同密码，请勿分享备份文件。本工具不上传任何数据到第三方服务器。

## 端点说明（已实测验证）

| 用途 | 国内版（Qoder CN） | 国际版（Qoder） |
|---|---|---|
| OAuth 登录页 | `qoder.com.cn/device/selectAccounts` | `qoder.com/device/selectAccounts` |
| OpenAPI（账号/额度/签到） | `openapi.qoder.com.cn` | `openapi.qoder.sh` |
| 流式对话（Cosy SSE） | `gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation` | `api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation` |
| Cloud Agents（PAT） | `api.qoder.com.cn/api/v1/cloud` | `api.qoder.com/api/v1/cloud` |
| Token 续期 | `POST /api/v1/deviceToken/refresh` | 同左 |

国内版端点来自阿里云官方防火墙白名单与多个开源项目交叉验证；国际版端点来自 qoder2api 与 Qoder 官方
Cloud Agents 文档。个别未公开字段（如 CN 版 OAuth client_id）标注为推断，可在「设置 → API 端点覆盖」中修改。

## 已知限制

- **客户端切换写路径已做 round-trip 验证，但未做跨账号实测**（会终止用户正在运行的 Qoder 进程，需自行确认后使用）；切换前会自动备份 `auth.v1.dat` / `state.vscdb` 到同目录 `.bak-<时间>`。
- macOS / Linux 的客户端登录态加密密钥在系统钥匙串中，暂不支持自动读写（可 OAuth 登录 / 手动添加账号，反代功能不受影响）。
- `request_set_id` 字段实测会导致国内版网关挂起，已从请求体中移除（见 docs/API-PROXY.md）。
- 国际版 legacy 流式端点（api3.qoder.sh）按 qoder2api 移植，未持国际版账号实测。

## 更新日志

### v1.1.1

- 修复 GitHub Actions 中 `npm ci` 因可选依赖锁文件不一致导致发布失败的问题
- 其余功能与 v1.1.0 相同

### v1.1.0

- 重做界面：深色侧栏 + 浅色工作区、完整暗色模式、移动端抽屉导航、统一卡片与图表样式
- 修复备份导入导出不包含登录态、OAuth 无法打开系统浏览器、Token 过期状态不显示、套餐信息不显示等问题
- 修复切换账号对话框在父组件刷新时可能重复触发切换任务的问题
- 修复反代端口占用时状态误报、设置保存时反代被无谓重启、签到 `none` 状态被误记为已签到等问题
- 统一 Node / Rust 账号库字段命名为 camelCase，并兼容旧数据迁移
- 修复自动签到使用 UTC 日期、错过整点后不补签的问题

## 致谢

- [WorkBuddy-Switch2api](https://github.com/cv-superding/WorkBuddy-Switch2api) — 界面与架构参考
- [qoder2api](https://github.com/jyao0708/qoder2api) — Qoder Cosy/Cloud 协议参考
- [Qoder-Switch](https://github.com/70548887/Qoder-Switch) — 客户端切换与会话管理参考
- [cpa-multi-plugins](https://github.com/lg996/cpa-multi-plugins) / [dsh-qoder-connect](https://github.com/YSwo-fei/dsh-qoder-connect) — Qoder CN 端点交叉验证

## 免责声明

本项目仅供学习与研究使用。多账号切换与反代可能违反 Qoder 服务条款，请自行评估风险；
作者不对账号封禁、数据丢失等后果负责。
