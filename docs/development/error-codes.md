# 错误码参考

> **契约来源**: [`shared/types.ts`](../../shared/types.ts)、[`server/src/lib/response.ts`](../../server/src/lib/response.ts)

---

## 统一响应格式

所有 `/api/*` 与 `/health` 响应均遵循统一信封结构 `ApiEnvelope<T>`：

```json
{
  "code": 40001,
  "message": "Invalid username or password",
  "data": null
}
```

| 字段      | 类型     | 描述                              |
| --------- | -------- | --------------------------------- |
| `code`    | number   | 业务状态码（成功固定为 `20000`）  |
| `message` | string   | 人类可读提示信息                  |
| `data`    | any/null | 成功载荷或 `null`                 |

---

## 错误码一览

### 成功响应

| 错误码  | 常量名 | HTTP 状态 | 说明                     |
| ------- | ------ | --------- | ------------------------ |
| `20000` | `OK`   | 200 / 201 | 请求成功                 |

### 客户端与权限错误 (`4xxxx`)

| 错误码  | 常量名                  | HTTP 状态 | 触发场景                                                 | 建议处理方式                                  |
| ------- | ----------------------- | --------- | -------------------------------------------------------- | --------------------------------------------- |
| `40001` | `INVALID_CREDENTIALS`   | 401       | 登录用户名/密码错误，或修改密码时 `old_password` 不正确  | 提示重新输入凭据                              |
| `40002` | `FORBIDDEN`             | 403       | 非管理员访问管理员接口、操作他人资源或 Cookie CSRF 校验失败 | 检查用户角色、资源归属或请求 `Origin`/JSON 头 |
| `40003` | `UNAUTHORIZED`          | 401       | 缺少凭据、Session 过期/无效、API Key 无效                | 清除本地会话并跳转登录，或检查 `X-API-Key`    |
| `40004` | `VALIDATION_ERROR`      | 400 / 413 | 参数缺失/越界、JSON 格式非法、或单次请求体超过 `1 MiB`   | 按接口字段校验规则修正请求                    |
| `40005` | `NOT_FOUND`             | 404       | 用户、API Key、分组或 API 路径不存在                     | 确认目标 ID 或路径是否正确                    |
| `40006` | `CONFLICT`              | 409       | 分组重名、尝试删除自己账号、命令状态不允许当前操作       | 检查目标当前状态后重试                        |
| `40009` | `USER_EXISTS`           | 409       | 创建用户时用户名已存在                                   | 更换用户名                                    |
| `40010` | `DEVICE_NOT_FOUND`      | 404       | 设备或 Agent ID 不存在                                   | Agent 收到 `40010` 时会自动清除 `state.json` 并重注册 |
| `40011` | `DEVICE_OFFLINE`        | 409       | 契约预留：设备处于离线状态                               | 等待设备上线后重试                            |
| `40013` | `REGISTRATION_DISABLED` | 403       | `CSLITE_ALLOW_REGISTRATION=false` 时拒绝新 Agent 注册    | 启用注册或提前预创建并核对服务端配置          |
| `40020` | `EXECUTION_NOT_FOUND`   | 404       | 命令、执行记录或结果日志不存在                           | 确认 `command_id` / `execution_id` / `result_id` |

### 服务端与调度错误 (`5xxxx` / `6xxxx`)

| 错误码  | 常量名           | HTTP 状态 | 触发场景                                               | 建议处理方式                                  |
| ------- | ---------------- | --------- | ------------------------------------------------------ | --------------------------------------------- |
| `50001` | `INTERNAL_ERROR` | 500       | 未捕获服务端异常，或 Worker 未绑定 `DB` / Turso 数据库 | 查看服务端日志或检查 `wrangler.toml` / 环境变量 |
| `60002` | `INVALID_CRON`   | 400       | `cron` 命令缺少 `schedule` 或 5 字段 UTC 表达式非法    | 校验 5 字段 Cron 语法（`分 时 日 月 周`）     |

---

## 服务端与前端错误处理示例

### TypeScript 服务端（Hono）

```ts
import { ErrorCode } from '../../../shared/types';
import { fail, ok, HttpApiError } from '../lib/response';

// 返回业务错误
return fail(c, ErrorCode.DEVICE_NOT_FOUND, 'Device not found', 404);

// 或抛出 HttpApiError 由 app.onError 统一转换
throw new HttpApiError(ErrorCode.VALIDATION_ERROR, 'Request payload too large', 413);
```

### TypeScript 前端（`web/src/api.ts`）

```ts
if (payload.code !== ErrorCode.OK || !res.ok) {
  if (payload.code === ErrorCode.UNAUTHORIZED || res.status === 401) {
    // 触发未授权回调，清理状态并跳转 #/login
  }
  throw new ApiError(payload.message, payload.code, res.status);
}
```

### Agent 侧对 `40010` 的自愈行为

当 `/api/agent/heartbeat` 或 `/api/agent/commands` 返回 `code = 40010`（`DEVICE_NOT_FOUND`，例如设备在控制台被删除）时，Go Agent 与 `cslite-agent-lite.sh` 会自动清理本地 `state.json` 并调用 `POST /api/agent/register` 重新注册。

---

## 相关文档

- [服务端概览](../server/overview.md)
- [环境配置](./environment.md)
- [认证 API](../server/api/auth.md)
- [Agent 通信协议](../agent/api.md)
