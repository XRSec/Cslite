# 认证 API（概要）

- 登录成功设置 Cookie 会话；响应体含 `data.user` 与 `data.session_token`
- 开发模式默认 HTTP；生产建议 HTTPS 并启用 Cookie Secure

---

## 接口概览

| 接口 | 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|------|
| 用户登录 | POST | `/auth/login` | 用户登录认证 | 公开 |
| 用户注销 | POST | `/auth/logout` | 用户注销登录 | 需要登录 |
| 生成 API Key | POST | `/auth/key` | 生成个人 API Key | 需要登录 |
| 添加用户 | POST | `/auth/user` | 添加新用户 | 管理员 |
| 获取用户列表 | GET | `/auth/user` | 获取用户列表 | 管理员 |
| 删除用户 | DELETE | `/auth/user/{id}` | 删除指定用户 | 管理员 |

---

## 用户登录

### `POST /auth/login`

用户登录认证，成功后设置 Session Cookie。

**请求参数**：

```json
{
  "username": "admin",
  "password": "SecurePass123!"
}
```

| 参数名   | 类型   | 必填 | 说明     |
| -------- | ------ | ---- | -------- |
| username | string | 是   | 用户名   |
| password | string | 是   | 密码     |

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "登录成功",
  "data": {
    "user": {
      "id": 1001,
      "username": "admin",
      "email": "admin@example.com",
      "role": 1
    },
    "session_token": "sess_abc123def456"
  }
}
```

**设置 Cookie**：

```
Set-Cookie: session=sess_abc123def456; Path=/; HttpOnly; Secure; Max-Age=604800
```

**错误响应**：

| 错误码 | HTTP 状态 | 说明           |
| ------ | --------- | -------------- |
| 40001  | 401       | 用户名或密码错误 |
| 40004  | 400       | 参数缺失或格式错误 |
| 40007  | 429       | 登录尝试过于频繁 |

**示例**：

```bash
curl -X POST https://api.cslite.com/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "SecurePass123!"
  }'
```

---

## 用户注销

### `POST /auth/logout`

用户注销登录，清除 Session。

**请求参数**：无

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "已注销",
  "data": null
}
```

**清除 Cookie**：

```
Set-Cookie: session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT
```

**错误响应**：

| 错误码 | HTTP 状态 | 说明           |
| ------ | --------- | -------------- |
| 40003  | 401       | 登录状态已过期 |

**示例**：

```bash
curl -X POST https://api.cslite.com/auth/logout \
  -H "Cookie: session=sess_abc123def456"
```

---

## 生成 API Key

### `POST /auth/key`

生成个人 API Key，用于程序化访问。

**请求参数**：无

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "API Key 生成成功",
  "data": {
    "api_key": "ak_live_abc123def456",
    "created_at": "2025-06-20T09:30:00Z"
  }
}
```

**错误响应**：

| 错误码 | HTTP 状态 | 说明           |
| ------ | --------- | -------------- |
| 40002  | 403       | 权限不足       |
| 40003  | 401       | 登录状态已过期 |

**示例**：

```bash
curl -X POST https://api.cslite.com/auth/key \
  -H "Cookie: session=sess_abc123def456"
```

---

## 添加用户

### `POST /auth/user`

添加新用户（仅管理员）。

**请求参数**：

```json
{
  "username": "new_user",
  "password": "P@ssw0rd123",
  "email": "user@example.com",
  "role": 0
}
```

| 参数名   | 类型   | 必填 | 说明                    |
| -------- | ------ | ---- | ----------------------- |
| username | string | 是   | 用户名（3-50字符）      |
| password | string | 是   | 密码（8-128字符）       |
| email    | string | 否   | 邮箱地址                |
| role     | int    | 否   | 角色（0:用户 1:管理员） |

**成功响应** (201)：

```json
{
  "code": 20000,
  "message": "用户创建成功",
  "data": {
    "id": 1003,
    "username": "new_user",
    "email": "user@example.com",
    "role": 0,
    "created_at": "2025-06-19T09:15:00Z"
  }
}
```

**错误响应**：

| 错误码 | HTTP 状态 | 说明           |
| ------ | --------- | -------------- |
| 40002  | 403       | 权限不足       |
| 40004  | 400       | 参数缺失或格式错误 |
| 40008  | 400       | 数据验证失败   |
| 40009  | 409       | 用户名已存在   |

**示例**：

```bash
curl -X POST https://api.cslite.com/auth/user \
  -H "Content-Type: application/json" \
  -H "Cookie: session=sess_abc123def456" \
  -d '{
    "username": "new_user",
    "password": "P@ssw0rd123",
    "email": "user@example.com",
    "role": 0
  }'
```

---

## 获取用户列表

### `GET /auth/user`

获取用户列表（仅管理员）。

**查询参数**：

| 参数名 | 类型   | 必填 | 说明           |
| ------ | ------ | ---- | -------------- |
| page   | int    | 否   | 页码（默认1）  |
| limit  | int    | 否   | 每页数量（默认20） |
| role   | int    | 否   | 角色过滤       |
| search | string | 否   | 用户名搜索     |

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "获取成功",
  "data": {
    "total": 15,
    "page": 1,
    "per_page": 5,
    "users": [
      {
        "id": 1001,
        "username": "admin",
        "email": "admin@example.com",
        "role": 1,
        "created_at": "2025-01-01T00:00:00Z"
      },
      {
        "id": 1002,
        "username": "user1",
        "email": "user1@example.com",
        "role": 0,
        "created_at": "2025-02-15T10:30:00Z"
      }
    ]
  }
}
```

**错误响应**：

| 错误码 | HTTP 状态 | 说明           |
| ------ | --------- | -------------- |
| 40002  | 403       | 权限不足       |
| 40003  | 401       | 登录状态已过期 |

**示例**：

```bash
curl -X GET "https://api.cslite.com/auth/user?page=1&limit=10" \
  -H "Cookie: session=sess_abc123def456"
```

---

## 删除用户

### `DELETE /auth/user/{user_id}`

删除指定用户（仅管理员）。

**路径参数**：

| 参数名  | 类型 | 必填 | 说明   |
| ------- | ---- | ---- | ------ |
| user_id | int  | 是   | 用户ID |

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "用户删除成功",
  "data": {
    "deleted_at": "2025-06-19T10:20:00Z"
  }
}
```

**错误响应**：

| 错误码 | HTTP 状态 | 说明           |
| ------ | --------- | -------------- |
| 40002  | 403       | 权限不足       |
| 40005  | 404       | 用户不存在     |
| 40006  | 409       | 无法删除自己   |

**示例**：

```bash
curl -X DELETE https://api.cslite.com/auth/user/1003 \
  -H "Cookie: session=sess_abc123def456"
```

---

## 认证方式

### 1. Session Cookie 认证

适用于 Web 界面访问：

```bash
# 登录后自动设置 Cookie
curl -X POST https://api.cslite.com/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "password"}' \
  -c cookies.txt

# 后续请求自动携带 Cookie
curl -X GET https://api.cslite.com/devices \
  -b cookies.txt
```

### 2. API Key 认证

适用于程序化访问：

```bash
# 在请求头中携带 API Key
curl -X GET https://api.cslite.com/devices \
  -H "X-API-Key: ak_live_abc123def456"
```

### 3. Bearer Token 认证

适用于第三方集成：

```bash
# 在请求头中携带 Bearer Token
curl -X GET https://api.cslite.com/devices \
  -H "Authorization: Bearer sess_abc123def456"
```

---

## 权限说明

### 用户角色

| 角色值 | 角色名 | 权限说明 |
| ------ | ------ | -------- |
| 0      | 普通用户 | 仅能管理自己的设备和命令 |
| 1      | 管理员 | 可以管理所有用户、设备和命令 |

### 接口权限

| 接口 | 普通用户 | 管理员 |
|------|----------|--------|
| 登录 | ✓        | ✓      |
| 注销 | ✓        | ✓      |
| 生成 API Key | ✓ | ✓ |
| 添加用户 | ✗ | ✓ |
| 获取用户列表 | ✗ | ✓ |
| 删除用户 | ✗ | ✓ |

---

## 安全建议

### 1. 密码安全
- 密码长度至少 8 位
- 包含大小写字母、数字和特殊字符
- 定期更换密码

### 2. API Key 安全
- 定期轮换 API Key
- 不要在代码中硬编码
- 使用环境变量存储

### 3. 会话安全
- 使用 HTTP 传输
- 设置合理的会话过期时间
- 支持会话撤销

---

## 相关文档

- [权限控制](./permissions.md) - 用户角色和权限说明
- [错误码参考](../development/error-codes.md) - 错误处理
- [设备管理](./devices.md) - 设备管理接口
- [命令管理](./commands.md) - 命令管理接口 