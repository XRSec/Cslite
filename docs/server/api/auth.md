# 认证与用户 API

> **路由前缀**: `/api/auth`（[源码：`server/src/routes/auth.ts`](../../../server/src/routes/auth.ts)）

- 登录成功设置 `cslite_session` HttpOnly Cookie，并在响应体返回 `data.user` 与 `data.session_token`。
- 支持 Cookie 会话（`Cookie: cslite_session=...`）、`X-API-Key: ak_live_...` 与 `Authorization: Bearer ...`。

---

## 接口概览

| 接口         | 方法   | 路径                    | 描述                   | 权限     |
| ------------ | ------ | ----------------------- | ---------------------- | -------- |
| 用户登录     | POST   | `/api/auth/login`       | 用户登录认证           | 公开     |
| 用户注销     | POST   | `/api/auth/logout`      | 注销当前会话           | 需要登录 |
| 当前用户     | GET    | `/api/auth/me`          | 获取当前登录用户信息   | 需要登录 |
| 修改密码     | POST   | `/api/auth/password`    | 修改当前用户密码       | 需要登录 |
| API Key 列表 | GET    | `/api/auth/key`         | 查询个人 API Key 列表  | 需要登录 |
| 生成 API Key | POST   | `/api/auth/key`         | 创建新 API Key         | 需要登录 |
| 删除 API Key | DELETE | `/api/auth/key/{id}`    | 删除指定 API Key       | 本人或管理员 |
| 获取用户列表 | GET    | `/api/auth/user`        | 分页查询用户列表       | 管理员   |
| 添加用户     | POST   | `/api/auth/user`        | 创建新用户             | 管理员   |
| 删除用户     | DELETE | `/api/auth/user/{id}`   | 删除指定用户           | 管理员   |

---

## 用户登录

### `POST /api/auth/login`

校验用户名与密码（PBKDF2-SHA256），签发会话并写入 `cslite_session` Cookie。

**请求参数**：

```json
{
  "username": "admin",
  "password": "admin"
}
```

| 参数名   | 类型   | 必填 | 说明   |
| -------- | ------ | ---- | ------ |
| username | string | 是   | 用户名 |
| password | string | 是   | 密码   |

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "Login successful",
  "data": {
    "user": {
      "id": 1,
      "username": "admin",
      "email": "admin@cslite.local",
      "role": 1,
      "created_at": "2026-01-01T00:00:00.000Z",
      "updated_at": "2026-01-01T00:00:00.000Z"
    },
    "session_token": "sess_a1b2c3d4..."
  }
}
```

**响应头**：

```text
Set-Cookie: cslite_session=sess_a1b2c3d4...; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800
```

> 当请求通过 HTTPS（或 `X-Forwarded-Proto: https` / `CSLITE_COOKIE_SECURE=true`）到达时，会自动附加 `; Secure`。

**错误响应**：

| 错误码 | HTTP 状态 | 说明               |
| ------ | --------- | ------------------ |
| 40004  | 400       | 缺少用户名或密码   |
| 40001  | 401       | 用户名或密码错误   |

**示例**：

```bash
curl -X POST http://127.0.0.1:9000/api/auth/login \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"username":"admin","password":"admin"}'
```

---

## 用户注销

### `POST /api/auth/logout`

删除服务端会话记录并清除 `cslite_session` Cookie。

```bash
curl -X POST http://127.0.0.1:9000/api/auth/logout \
  -H "Content-Type: application/json" \
  -b cookies.txt
```

**成功响应** (200)：`{"code":20000,"message":"Logged out","data":null}`

---

## 获取当前用户

### `GET /api/auth/me`

返回当前会话对应的 `UserDTO`。

```bash
curl http://127.0.0.1:9000/api/auth/me -b cookies.txt
```

---

## 修改当前用户密码

### `POST /api/auth/password`

校验旧密码并更新为新密码（6-128 字符），同时吊销该用户的其他历史会话。

**请求参数**：

```json
{
  "old_password": "admin",
  "new_password": "NewStrongPassword!"
}
```

**错误响应**：`40004`（400 参数校验失败）、`40001`（401 原密码不正确）。

---

## API Key 管理

### `GET /api/auth/key`

列出当前用户的 API Key 元数据（仅含 `key_prefix`，不返回明文密钥）。

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "OK",
  "data": {
    "total": 1,
    "keys": [
      {
        "id": "key_0123456789abcdef",
        "name": "edge-agents",
        "key_prefix": "ak_live_9f8e...",
        "user_id": 1,
        "created_at": "2026-01-01T00:00:00.000Z",
        "last_used": null
      }
    ]
  }
}
```

### `POST /api/auth/key`

创建新的个人 API Key（`ak_live_` 前缀），**原始密钥 `api_key` 仅在创建响应中返回一次**。

**请求参数**（可选）：

```json
{
  "name": "agent-openwrt-gw"
}
```

**成功响应** (201)：

```json
{
  "code": 20000,
  "message": "API key created",
  "data": {
    "id": "key_0123456789abcdef",
    "name": "agent-openwrt-gw",
    "api_key": "ak_live_0123456789abcdef0123456789abcdef01234567",
    "key_prefix": "ak_live_0123...",
    "created_at": "2026-01-01T00:00:00.000Z"
  }
}
```

### `DELETE /api/auth/key/{id}`

删除指定 API Key（仅密钥所有者或管理员可操作）。

```bash
curl -X DELETE http://127.0.0.1:9000/api/auth/key/key_0123456789abcdef \
  -H "Content-Type: application/json" \
  -b cookies.txt
```

---

## 用户管理（仅管理员）

### `GET /api/auth/user`

分页获取用户列表。支持查询参数：`page`（默认 `1`）、`limit` / `per_page`（默认 `20`，上限 `100`）、`role`（`0` 或 `1`）、`search`（匹配用户名或邮箱）。

### `POST /api/auth/user`

创建新用户。

| 参数名   | 类型   | 必填 | 说明                                    |
| -------- | ------ | ---- | --------------------------------------- |
| username | string | 是   | 3-50 字符，允许字母、数字、`_`、`.`、`-` |
| password | string | 是   | 6-128 字符                              |
| email    | string | 否   | 邮箱地址                                |
| role     | int    | 否   | `0` 普通用户（默认），`1` 管理员        |

**成功响应** (201)：返回 `UserDTO`。  
**错误响应**：`40004`（400 参数非法）、`40009`（409 用户名已存在）、`40002`（403 非管理员）。

### `DELETE /api/auth/user/{id}`

删除指定用户及其关联会话与 API Key（不可删除当前登录管理员自身，否则返回 `40006` / HTTP `409`）。

---

## 认证请求方式示例

```bash
# 1. Session Cookie（推荐 Web 与 curl 脚本）
curl -X GET http://127.0.0.1:9000/api/devices -b cookies.txt

# 2. API Key（推荐 Agent 与自动化工具）
curl -X GET http://127.0.0.1:9000/api/devices \
  -H "X-API-Key: ak_live_0123456789abcdef0123456789abcdef01234567"

# 3. Bearer Token（支持 session_token 或 ak_live_ API Key）
curl -X GET http://127.0.0.1:9000/api/devices \
  -H "Authorization: Bearer ak_live_0123456789abcdef0123456789abcdef01234567"
```

---

## 相关文档

- [权限与认证机制](./permissions.md)
- [错误码参考](../../development/error-codes.md)
- [设备与分组 API](./devices.md)
- [命令与日志 API](./commands.md)
