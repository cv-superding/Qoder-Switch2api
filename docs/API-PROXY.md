# Qoder 协议与反代实现细节

本文记录 Qoder-Switch2api 后端与 Qoder 服务交互的协议细节、实测结论与代码位置，便于后续维护。

## 1. 认证体系

### 1.1 OAuth 设备流（推荐）

复刻自 qoder2api `internal/auth/device_login.go`：

```
1. 生成 PKCE：verifier(32B random) → challenge = base64url(sha256(verifier))，method=S256
2. 验证 URL：{loginBaseUrl}/device/selectAccounts?nonce=&challenge=&challenge_method=S256&client_id=&machine_id=
3. 轮询：GET {openapi}/api/v1/deviceToken/poll?nonce=&verifier=&challenge_method=S256
   - 404 = 用户未完成授权，继续轮询（间隔 1.5s，超时 10min）
   - 200 + {token, user_id, refresh_token, expires_at, refresh_token_expires_at}
4. 拉取用户信息：
   - GET {openapi}/api/v1/userinfo                （Bearer token）
   - GET {openapi}/api/v3/user/status              （Bearer + Cosy-ClientType/MachineOS/MachineToken/MachineType）
   - GET {openapi}/api/v2/user/plan                （Bearer token）
```

token 前缀约定（实测）：访问令牌 `dt-`（约 30 天），刷新令牌 `drt-`（约 1 年）。

### 1.2 Token 续期

```
POST {openapi}/api/v1/deviceToken/refresh
Body: {"refresh_token": "drt-..."}
→ {"device_token": "dt-...", "refresh_token": "drt-...", "expires_at": "..."}
```

服务端每次续期轮换 refresh_token，旧值短暂有效。续期失败（refresh 也过期，约一年）需重新登录。

### 1.3 PAT（Cloud Agents）

Qoder 控制台 Settings → Personal Access Tokens 创建，走 `api.qoder.com/api/v1/cloud`（国际版）/
`api.qoder.com.cn/api/v1/cloud`（国内版）。与 IDE 登录态相互独立。

## 2. 客户端登录态（账号切换的原理）

### 2.1 存储位置（实测于 Windows + Qoder CN 新版客户端）

| 版本 | 数据目录 | 登录态文件 |
|---|---|---|
| Qoder CN 新版 | `%APPDATA%\com.qodercn.app.stable` | `auth.v1.dat` |
| Qoder CN 旧版 | `%APPDATA%\QoderCN` 等 | `User/globalStorage/state.vscdb` 的 `secret://aicoding.auth.userInfo` |
| Qoder 国际版 | `%APPDATA%\Qoder` | 同上两种之一 |

新版客户端目录同时含 `Local State`（OSCrypt 密钥）、`auth.machine-id`（机器标识）。

### 2.2 auth.v1.dat 加解密（Chromium OSCrypt v10）

```
密钥：Local State → os_crypt.encrypted_key（base64，前缀 "DPAPI"）
      → Windows DPAPI Unprotect(CurrentUser) → 32B AES-256 密钥
密文：[3B "v10"][12B nonce][ciphertext][16B GCM tag]
明文：{"schemaVersion":1,"token":"dt-…","refreshToken":"drt-…",
       "expiresAt":"2026-11-14T11:53:53Z","refreshTokenExpiresAt":"…",
       "user":{"id","name","email","phone"}}
```

代码：`server/crypto.js`（loadOscryptKey / oscryptDecrypt / oscryptEncrypt）、`server/switcher.js`。

### 2.3 切换流程

```
备份当前登录态（.bak-<ISO时间>）→ taskkill 结束 Qoder 进程 →
OSCrypt 重写 auth.v1.dat（保留原结构，仅替换 token/refreshToken/expiresAt/user）→ 重启客户端
```

已做**同账号 round-trip 实测**（写回后读回 token/user 完全一致）。跨账号切换未实测（需终止用户客户端）。

## 3. legacy 流式对话（Cosy 协议）

复刻自 qoder2api `internal/qoder/legacy.go` 与 Qoder-Switch `auth/cosy.rs`：

### 3.1 请求

```
POST {streamUrl}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
Content-Type: application/json
Body = legacyEncode(JSON.stringify(payload))     # 自定义 base64，见 3.3
```

### 3.2 Cosy 签名头

```
1. aesKey = uuid_无横线[:16]
2. info   = base64(AES-128-CBC(json({name,aid,uid,yx_uid,organization_id,
   organization_name,user_type,security_oauth_token,refresh_token}), key=aesKey, iv=aesKey))
   # IV 复用 key 本身是 Qoder 服务端约定，非标准实践
3. cosyKey = base64(RSA-PKCS1v15-Encrypt(serverPubKey, aesKey))
4. payload = base64({version:"v1", requestId, info, cosyVersion:"0.1.43", ideVersion:""})
5. sig = md5(payload + "\n" + cosyKey + "\n" + cosyDate + "\n" + body + "\n" + streamPath)
6. 头：
   authorization: Bearer COSY.{payload}.{sig}
   cosy-user / cosy-key / cosy-date / cosy-machineid / cosy-machinetoken / cosy-machinetype
   cosy-clienttype: 5 / cosy-clientip / cosy-data-policy: AGREE / cosy-version / login-version: v2
   x-model-key: <model> / x-model-source: system
```

machine token/type 缺失时生成随机值（uuid 拼接后 base64url / 18B hex），与参考实现一致。

### 3.3 legacyEncode / legacyDecode

标准 base64 → 按 `n/3` 分段做「末段前置」重排 → 逐字符替换到自定义字母表
`_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!`（`=` → `$`）。
代码：`server/qoder/cosy.js`。

### 3.4 SSE 响应

每行 `data:{"headers":{...},"body":"<OpenAI chunk JSON>","statusCodeValue":200}`，
内层 body 是标准 OpenAI chunk（`choices[0].delta.{content,reasoning_content,tool_calls}` + `usage`）。
解析：`server/qoder/chat.js` `parseLegacyLine`。

### 3.5 ⚠️ 实测结论：不要携带 request_set_id

国内版网关（gateway.qoder.com.cn）实测：请求体包含 `request_set_id`（任意值，UUID 或空串）时
返回 200 但**只有空的 `data:` keep-alive，之后无限期挂起**；去掉该字段后 5 秒内正常流式返回。
国际版 api3.qoder.sh 未验证该字段必要性，统一不带。代码：`newLegacyTemplate()` 注释。

## 4. Cloud Agents（PAT）

```
1. GET  /api/v1/cloud/environments            取 ready 环境，没有则 POST 创建
2. POST /api/v1/cloud/agents                  {name, model, system, tools:[bash/text_editor]}
3. POST /api/v1/cloud/sessions                {agent, environment_id}
4. POST /api/v1/cloud/sessions/{id}/events    {events:[{type:"user.message", content}]}
5. GET  /api/v1/cloud/sessions/{id}/events/stream   （SSE）
   事件：agent.message → content；agent.tool_use → tool_calls；
        session.status_idle / terminated → 结束；session.error → 失败
```

代码：`server/qoder/chat.js` `CloudSession` / `cloudStream`。

## 5. 账号信息接口

| 接口 | 路径 | 说明 |
|---|---|---|
| 订阅套餐 | `GET /api/v2/user/plan` | `{user_type, plan_tier_name, start_date, end_date}` |
| 额度用量 | `GET /api/v2/quota/usage` | `{userQuota:{total,used,remaining,percentage,unit}, expiresAt, isQuotaExceeded}` |
| 个人用量 | `GET /sash/api/v2/me/usage` | 加购 + 套餐额度汇总 |
| 活动列表 | `GET /sash/api/v1/me/campaigns` | 每日签到以 campaign 形式存在 |
| 领取奖励 | `POST /sash/api/v1/me/campaigns/{id}/claim` | 幂等，重复领取返回 `replayed:true` |
| 模型列表 | `GET {gateway}/algo/api/v2/model/list?Encode=1` | 响应可能是明文 JSON / {body} 信封 / legacy 编码，逐一兼容 |

签到判定：`actionType === "CLAIM_BENEFIT"` 且 `claimStatus === "CLAIMABLE"` 才领取；
`CLAIMED/REPLAYED` 视为已签到。代码：`server/qoder/info.js`。

## 6. 反代网关

- 每档位一个 Express 实例（国内 :7891 / 国际 :7892，可改），账号池按档位隔离。
- 选号：健康账号（未禁用/未冷却、group ≠ desktop）中额度剩余比最高者，同级 round-robin。
- 失败：HTTP 4xx/5xx → 冷却 120s 换号重试（最多 3 次）；401/403 → 先尝试一次 token 续期再用同号重试。
- 用量：请求结束记录 `{account, model, promptTokens, completionTokens, totalTokens, api, success}` 到
  `~/.qoder-switch/usage.json`（保留最近 5000 条）。
- 模型：`auto`（默认）/ `lite` / 透传上游 key；`/v1/models` 返回默认 + 上游（缓存 10min）+ 额外放行。

## 7. 会话管理

- 工作区：`User/workspaceStorage/{id}/workspace.json` → `folder`（file:// URI）解码得路径。
- 聊天历史：`User/globalStorage/state.vscdb` 的 `lingma.chat.localHistory.{workspaceId}`（明文 JSON 数组）。
- SQLite 访问用 Node 内置 `node:sqlite`（需 `--experimental-sqlite`，package.json 已带）；
  不可用时相关功能降级提示，不影响其他模块。
