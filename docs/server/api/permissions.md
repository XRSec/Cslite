# 权限与认证机制

> **实现源码**: [`server/src/middleware/auth.ts`](../../../server/src/middleware/auth.ts)、[`server/src/lib/crypto.ts`](../../../server/src/lib/crypto.ts)

---

## 认证方式

除 `GET /health`、`GET /api/system/info`、`POST /api/auth/login` 与单页前端 HTML 外，所有 `/api/*` 接口均需通过以下任一凭据完成认证：

1. **Session Cookie（Web UI 推荐）**
   - 登录 `POST /api/auth/login` 后服务端下发：`Set-Cookie: cslite_session=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<ttl>`（HTTPS 下自动附带 `Secure`，可通过 `CSLITE_COOKIE_SECURE` 覆盖；同时向后兼容读取旧 Cookie 名 `session`）。
   - **CSRF 防护**：使用 Cookie 认证发起非 `GET`/`HEAD`/`OPTIONS` 写请求时，中间件 `verifyCsrf` 校验 `Origin` 或 `Referer` 主机与当前请求 `Host` / `X-Forwarded-Host` 一致；若未携带 `Origin`/`Referer`，则要求 `Content-Type` 包含 `application/json`。
2. **API Key（Agent 与程序化调用推荐）**
   - 请求头 `X-API-Key: ak_live_...` 或 `Authorization: Bearer ak_live_...`（`/api/agent/*` 亦支持请求体 `api_key` 或查询参数 `?api_key=...`）。
   - 不受 Cookie CSRF 校验限制。
3. **Bearer Session Token（CLI / 第三方客户端）**
   - `POST /api/auth/login` 响应体同时返回 `data.session_token`，可在请求头中通过 `Authorization: Bearer <session_token>` 传递。

> 服务端数据库中仅保存 Session Token 与 API Key 的 **SHA-256 十六进制摘要**，不保存明文；用户密码采用 **PBKDF2-SHA256（100,000 次迭代 + 16 字节随机盐）** 存储与常量时间比对。

---

## 角色与资源隔离

| 角色值 | 角色名称              | 权限范围                                                                 |
| ------ | --------------------- | ------------------------------------------------------------------------ |
| `0`    | 普通用户（User）      | 仅可查询与操作本人创建的设备、分组、命令、命令/设备日志及自己的 API Key   |
| `1`    | 管理员（Administrator） | 通过 `requireAdmin` 中间件，可管理所有用户的设备/分组/命令、查看审计日志与管理用户 |

### 中间件与接口权限矩阵

| 路由前缀 / 接口                    | 认证中间件            | 普通用户 | 管理员 |
| ---------------------------------- | --------------------- | -------- | ------ |
| `GET /health`、`GET /api/system/info` | 公开                  | ✓        | ✓      |
| `POST /api/auth/login`             | 公开                  | ✓        | ✓      |
| `POST /api/auth/logout`、`GET /api/auth/me`、`POST /api/auth/password` | `requireAuth` | ✓ | ✓ |
| `/api/auth/key`、`DELETE /api/auth/key/:id` | `requireAuth` | 本人密钥 | 全部密钥 |
| `GET/POST /api/auth/user`、`DELETE /api/auth/user/:id` | `requireAuth` + `requireAdmin` | ✗ | ✓ |
| `/api/devices/*`、`/api/groups/*`、`/api/commands/*` | `requireAuth` | 本人资源 | 全部资源 |
| `GET /api/logs/command`、`GET /api/logs/device`、`GET /api/logs/download/:result_id` | `requireAuth` | 本人相关 | 全部日志 |
| `GET /api/logs/user`               | `requireAuth` + `requireAdmin` | ✗ | ✓ |
| `/api/agent/*`                     | `authenticateApiKey`  | 本人名下设备 | 全部设备 |
