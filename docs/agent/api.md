# Agent 通信协议

> **路由前缀**: `/api/agent`（[服务端：`server/src/routes/agent.ts`](../../server/src/routes/agent.ts)、[Go 客户端：`agent/internal/client/client.go`](../../agent/internal/client/client.go)）

---

## 接口概览

| 接口     | 方法        | 路径                  | 描述                                      | 认证    |
| -------- | ----------- | --------------------- | ----------------------------------------- | ------- |
| 注册设备 | POST        | `/api/agent/register` | 首次启动或绑定预创建设备                  | API Key |
| 心跳上报 | POST        | `/api/agent/heartbeat`| 定期上报在线状态、主机信息与系统指标      | API Key |
| 拉取命令 | GET / POST  | `/api/agent/commands` | 轮询并原子认领待执行任务                  | API Key |
| 上报结果 | POST        | `/api/agent/result`   | 上报命令执行状态、退出码与输出日志        | API Key |

> **认证方式**：优先读取请求头 `X-API-Key: ak_live_...`，亦兼容 `Authorization: Bearer ak_live_...`、JSON 请求体 `api_key` 字段或查询参数 `?api_key=...`。

---

## 1. Agent 注册

### `POST /api/agent/register`

当 `CSLITE_ALLOW_REGISTRATION=true`（默认）时允许注册。若传入预创建槽位的 `device_id`，则绑定该设备并更新其在线元数据；否则自动生成新设备 `dev_...` 与 `agent_...`。

**请求参数**：

```json
{
  "name": "openwrt-gw-01",
  "platform": "openwrt",
  "arch": "mipsle",
  "os_version": "OpenWrt 23.05",
  "hostname": "OpenWrt",
  "version": "v1.0.0",
  "device_id": "dev_0123456789abcdef"
}
```

| 参数名     | 类型   | 必填 | 说明                                          |
| ---------- | ------ | ---- | --------------------------------------------- |
| name       | string | 是   | 设备显示名称（1-100 字符）                    |
| platform   | string | 是   | 平台类型：`linux`/`openwrt`/`macos`/`windows` |
| version    | string | 是   | Agent 版本号                                  |
| arch       | string | 否   | CPU 架构（如 `amd64`/`arm64`/`armv7`/`mipsle`） |
| os_version | string | 否   | 系统发行版描述                                |
| hostname   | string | 否   | 主机名                                        |
| device_id  | string | 否   | 预创建设备 ID（绑定已有设备槽位）             |
| api_key    | string | 否   | 备选 API Key 传递方式（可替代请求头）         |

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "OK",
  "data": {
    "agent_id": "agent_0123456789abcdef",
    "device_id": "dev_0123456789abcdef",
    "heartbeat_interval": 60,
    "poll_interval": 10
  }
}
```

**常见错误**：`40003`（401 API Key 无效）、`40013`（403 注册已关闭）、`40004`（400 参数缺失）、`40010`（404 预创建 `device_id` 不存在）、`40002`（403 无权绑定他人预创建设备）。

---

## 2. 心跳上报

### `POST /api/agent/heartbeat`

定期上报设备存活状态与系统遥测指标。若服务端返回 `40010`（设备已被删除），Agent 会自动清除本地 `state.json` 并重新注册。

**请求参数**：

```json
{
  "agent_id": "agent_0123456789abcdef",
  "device_id": "dev_0123456789abcdef",
  "version": "v1.0.0",
  "os_version": "Ubuntu 24.04",
  "hostname": "node-01",
  "metrics": {
    "cpu_usage": 10.5,
    "memory_used": 1536,
    "memory_total": 4096,
    "memory_percent": 37.5,
    "disk_usage": 42.7,
    "disk_total": 40960,
    "network_in": 120,
    "network_out": 45,
    "load_avg": "0.18 0.14 0.10",
    "uptime": 172800
  },
  "timestamp": "2026-01-01T00:01:00Z"
}
```

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "OK",
  "data": {
    "status": "ok",
    "next_heartbeat": 60,
    "poll_interval": 10
  }
}
```

> `next_heartbeat` 与 `poll_interval` 均为整数秒数；未显式覆写间隔的 Agent 会动态应用服务端下发周期。

---

## 3. 拉取命令

### `GET /api/agent/commands` 与 `POST /api/agent/commands`

支持两种调用方式以兼容 OpenWrt BusyBox `uclient-fetch`（`POST` JSON Body 传参）及标准 `GET` Query 传参：
- `GET /api/agent/commands?agent_id=agent_xxx&limit=4`
- `POST /api/agent/commands`：`{"agent_id": "agent_xxx", "limit": 1}`

**查询 / 请求参数**：
- `agent_id`（必填）：已注册 Agent ID
- `limit`（可选）：单次最多认领任务数，范围 `1`-`20`，默认 `5`

**服务端原子拉取流程**：
1. 惰性回收全局超时执行记录（`reapTimedOutExecutions`）；
2. 惰性实例化当前设备及其所属分组到期的 `once`/`cron` 命令；
3. 按 `UPDATE execution_results SET status = 'running' ... WHERE id = ? AND status = 'queued'` 原子抢占任务；
4. 对 `devices.last_seen` 进行 30 秒节流刷新（防止高频轮询放大数据库写入）。

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "OK",
  "data": {
    "commands": [
      {
        "result_id": "res_0123456789abcdef",
        "command_id": "cmd_0123456789abcdef",
        "execution_id": "exec_0123456789abcdef",
        "name": "Disk Check",
        "type": "immediate",
        "content": "df -h",
        "timeout": 60,
        "shell": "sh",
        "env_vars": {
          "LC_ALL": "C"
        }
      }
    ]
  }
}
```

---

## 4. 上报命令执行结果

### `POST /api/agent/result`

**请求参数**：

```json
{
  "result_id": "res_0123456789abcdef",
  "execution_id": "exec_0123456789abcdef",
  "device_id": "dev_0123456789abcdef",
  "status": "completed",
  "exit_code": 0,
  "output": "Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda1        40G   12G   26G  32% /",
  "completed_at": "2026-01-01T00:01:05Z"
}
```

| 参数名       | 类型   | 必填 | 说明                                                      |
| ------------ | ------ | ---- | --------------------------------------------------------- |
| result_id    | string | 建议 | 任务结果 ID（与 `execution_id` + `device_id` 二重定位）   |
| execution_id | string | 是   | 执行批次 ID                                               |
| device_id    | string | 是   | 当前设备 ID                                               |
| status       | string | 是   | `completed`、`failed`、`timeout` 或 `cancelled`           |
| exit_code    | int    | 否   | 退出码（未传时 `completed` 默认 `0`，其余默认 `1`）       |
| output       | string | 否   | UTF-8 纯文本输出（服务端上限 `256 KiB`）                  |
| log          | string | 否   | 可选 Base64 编码完整日志（服务端自动 UTF-8 解码）         |
| completed_at | string | 否   | 完成时间（ISO-8601）                                      |

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "OK",
  "data": {
    "status": "received",
    "logged": true
  }
}
```

> 若该任务在结果上报前已被取消或超时回收，`logged` 返回 `false`，保证状态机幂等不回退。

---

## Agent 运行与自愈特性

- **快轮询突发（Fast-Poll Burst）**：Go Agent 与 `cslite-agent-lite` 在执行完一次任务后自动进入 15 秒的 `1s` 短周期轮询窗口，提升交互式控制台连续下发响应速度。
- **指数退避上报重试**：Go Agent 在遇到网络抖动或服务端 `5xx`/`429` 时自动按 `0.5s -> 1s -> 2s -> 4s` 指数退避重试（Lite 版按 `1s -> 2s -> 4s` 重试），对确定性 `4xx` 业务错误快速失败。
- **多端安装与部署**：详见 [`docs/deploy.md`](../deploy.md#4-跨平台-agent-部署)。
