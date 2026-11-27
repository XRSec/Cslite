# 命令与日志 API

> **路由前缀**: `/api/commands`、`/api/logs`（[源码：`commands.ts`](../../../server/src/routes/commands.ts)、[`logs.ts`](../../../server/src/routes/logs.ts)）

- 命令由用户通过 `/api/commands` 写入数据库；Agent 通过 `/api/agent/commands` 轮询原子抢占执行，并通过 `/api/agent/result` 上报结果。
- 本页同时包含命令关联的 `/api/logs/*` 查询与下载接口说明。

---

## 接口概览

### 命令管理 `/api/commands`

| 接口         | 方法 | 路径                          | 描述                             |
| ------------ | ---- | ----------------------------- | -------------------------------- |
| 创建命令     | POST | `/api/commands`               | 创建立即、一次性定时或 Cron 命令 |
| 命令列表     | GET  | `/api/commands`               | 分页与多条件筛选命令列表         |
| 命令详情     | GET  | `/api/commands/{id}`          | 获取命令详情及最近 50 次执行历史 |
| 更新命令状态 | PUT  | `/api/commands/{id}`          | 暂停、恢复或取消命令             |
| 获取执行结果 | GET  | `/api/commands/{id}/results`  | 分页查询各设备执行明细与日志链接 |

### 日志查询 `/api/logs`

| 接口         | 方法 | 路径                                 | 描述                     | 权限     |
| ------------ | ---- | ------------------------------------ | ------------------------ | -------- |
| 命令执行日志 | GET  | `/api/logs/command`                  | 查询命令执行结果摘要列表 | 需要登录 |
| 设备事件日志 | GET  | `/api/logs/device`                   | 查询设备注册/超时等事件  | 需要登录 |
| 用户审计日志 | GET  | `/api/logs/user`                     | 查询用户操作审计日志     | 管理员   |
| 下载原始日志 | GET  | `/api/logs/download/{result_id}`     | 下载单次结果纯文本日志   | 需要登录 |

---

## 调度语义

| 命令类型    | `schedule` 要求              | 实例化时机与行为                                                                 |
| ----------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `immediate` | 不需要                       | 创建命令时立即生成 `executions` 与 `execution_results`（`queued`），等待 Agent 拉取 |
| `once`      | 可选（ISO-8601 时间戳）      | 未传或时间已到则立即入队；传入未来时间则写入 `next_run_at`，到期后于 Agent 轮询时惰性实例化 |
| `cron`      | 必填（5 字段 UTC Cron 表达式） | 创建时校验（错误码 `60002`）并计算 `next_run_at`；到期由 Agent 轮询触发并推进下次时间，永不置为 `completed` |

> 定时与 `cron` 触发借助数据库唯一索引 `UNIQUE (command_id, scheduled_for)` 保证多 Agent / 多 Worker 并发轮询不重复实例化。

---

## 命令接口详情

### `POST /api/commands` — 创建命令

**请求参数**：

```json
{
  "name": "系统巡检",
  "type": "immediate",
  "content": "uname -a && uptime",
  "target_type": "devices",
  "target_ids": ["dev_0123456789abcdef"],
  "timeout": 60,
  "shell": "sh",
  "env_vars": {
    "LC_ALL": "C"
  },
  "retry_policy": {
    "enabled": false,
    "max_attempts": 1
  }
}
```

| 参数名       | 类型     | 必填 | 说明                                                  |
| ------------ | -------- | ---- | ----------------------------------------------------- |
| name         | string   | 是   | 命令名称（1-191 字符）                                |
| type         | string   | 是   | `immediate`、`once` 或 `cron`                         |
| schedule     | string   | 条件 | `cron` 必填 5 字段 UTC 表达式；`once` 可选 ISO-8601 时间 |
| content      | string   | 是   | 要执行的命令或脚本内容                                |
| target_type  | string   | 是   | `devices` 或 `groups`                                 |
| target_ids   | string[] | 是   | 目标设备或分组 ID 列表（非空）                        |
| timeout      | int      | 否   | 超时时间（`1`-`86400` 秒，默认读取 `CSLITE_DEFAULT_TIMEOUT` = `1800`） |
| shell        | string   | 否   | 指定执行 Shell（如 `sh`/`bash`/`ash`/`cmd`/`powershell`） |
| env_vars     | object   | 否   | 注入到命令子进程的环境变量键值对                      |
| retry_policy | object   | 否   | 重试策略 `{ enabled: boolean, max_attempts: number }` |

**成功响应** (201)：返回新建的 `CommandDTO`。  
**常见错误**：`40004`（400 参数非法）、`40010`（404 目标设备不存在）、`40005`（404 目标分组不存在）、`40002`（403 无权操作目标）、`60002`（400 非法 Cron 表达式）。

**示例**：

```bash
curl -X POST http://127.0.0.1:9000/api/commands \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "name": "每日清理",
    "type": "cron",
    "schedule": "0 3 * * *",
    "content": "df -h",
    "target_type": "groups",
    "target_ids": ["grp_0123456789abcdef"],
    "timeout": 120
  }'
```

### `GET /api/commands` — 获取命令列表

**查询参数**：
- `status`：`pending` / `running` / `completed` / `failed` / `paused` / `cancelled`
- `type`：`immediate` / `once` / `cron`
- `device` / `device_id`：关联设备 ID（通过 `execution_results` 与 `command_targets` 规范表过滤，兼容 SQLite 与 MySQL）
- `owner`：创建者 ID（仅管理员生效）
- `page`、`limit` / `per_page`

### `GET /api/commands/{id}` — 获取命令详情

查询前会自动回收超时任务（`reapTimedOutExecutions`），返回包含 `execution_history`（每条执行含 `device_results` 数组及 `log_url: "/api/logs/download/{result_id}"`）的完整 `CommandDetailDTO`。命令不存在返回 `40020`（HTTP `404`）。

### `PUT /api/commands/{id}` — 暂停 / 恢复 / 取消命令

**请求体**：`{"action": "pause" | "resume" | "cancel"}`

| 操作     | 允许的前置状态                  | 行为说明                                                     |
| -------- | ------------------------------- | ------------------------------------------------------------ |
| `pause`  | `pending`、`running`            | 置为 `paused`，停止新轮询认领                                |
| `resume` | `paused`                        | 恢复为 `pending`；若是 `cron` 且原 `next_run_at` 已过期则重算下次时间 |
| `cancel` | `pending`、`running`、`paused`  | 命令及未终态的 `executions` / `execution_results` 一并置为 `cancelled` |

状态冲突时返回 `40006`（HTTP `409`）。

### `GET /api/commands/{id}/results` — 分页获取命令执行结果

返回 `{ "command_id": "...", "executions": [...] }`，支持 `page` 与 `limit` 参数。

---

## 日志接口详情

- `GET /api/logs/command`：查询 `CommandLogDTO[]`，支持 `command_id`、`device_id`、`status`、`page`、`limit`；每条含 `output_preview`（前 500 字符）与 `log_url`。
- `GET /api/logs/device`：查询 `DeviceLogDTO[]`，支持 `device_id`、`type`、`page`、`limit`。
- `GET /api/logs/user`（仅管理员）：查询 `AuditLogDTO[]`，支持 `user_id`、`action`、`page`、`limit`。
- `GET /api/logs/download/{result_id}`：返回 `Content-Type: text/plain; charset=utf-8` 附件流（`cslite-{result_id}.log`）。

---

## 相关文档

- [权限与认证机制](./permissions.md)
- [设备与分组 API](./devices.md)
- [Agent 通信协议](../../agent/api.md)
- [错误码参考](../../development/error-codes.md)
