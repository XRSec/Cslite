# 设备与分组 API

> **路由前缀**: `/api/devices`、`/api/groups`（[源码：`devices.ts`](../../../server/src/routes/devices.ts)、[`groups.ts`](../../../server/src/routes/groups.ts)）

- 所有接口均需登录认证（`Cookie: cslite_session=...`、`X-API-Key` 或 `Bearer`）。
- 设备在线状态依据 `last_seen` 与 `max(CSLITE_HEARTBEAT_INTERVAL * 3, 90)` 秒阈值实时计算（默认心跳 60 秒对应 180 秒离线判定窗口）。

---

## 接口概览

### 设备管理 `/api/devices`

| 接口         | 方法               | 路径                         | 描述                             |
| ------------ | ------------------ | ---------------------------- | -------------------------------- |
| 预创建设备   | POST               | `/api/devices`               | 创建设备槽位并生成多平台安装命令 |
| 设备列表     | GET                | `/api/devices`               | 分页与多维度筛选设备列表         |
| 查询设备状态 | GET                | `/api/devices/status?id=...` | 查询单台设备实时在线状态与指标   |
| 设备详情     | GET                | `/api/devices/{id}`          | 获取单台设备完整信息             |
| 更新设备     | PATCH / PUT        | `/api/devices/{id}`          | 修改名称、平台或所属分组         |
| 批量删除设备 | DELETE / POST      | `/api/devices`、`/api/devices/batch-delete` | 批量删除多台设备 |
| 删除单个设备 | DELETE             | `/api/devices/{id}`          | 删除指定设备                     |

### 分组管理 `/api/groups`

| 接口         | 方法   | 路径                        | 描述                       |
| ------------ | ------ | --------------------------- | -------------------------- |
| 创建分组     | POST   | `/api/groups`               | 创建设备分组               |
| 分组列表     | GET    | `/api/groups`               | 获取分组及包含设备数量     |
| 更新分组     | PUT    | `/api/groups/{id}`          | 修改分组名称或描述         |
| 批量添加设备 | PUT    | `/api/groups/{id}/devices`  | 将多台设备绑定到指定分组   |
| 批量移除设备 | DELETE | `/api/groups/{id}/devices`  | 将设备从分组解绑           |
| 删除分组     | DELETE | `/api/groups/{id}`          | 删除分组并自动解绑旗下设备 |

---

## 设备接口详情

### `POST /api/devices` — 预创建设备

创建设备槽位并返回适用于 **Linux**、**OpenWrt (Go)**、**OpenWrt (Lite)**、**macOS** 与 **Windows** 的安装命令。

**请求参数**：

```json
{
  "name": "openwrt-gw-01",
  "platform": "openwrt",
  "group_id": "grp_0123456789abcdef"
}
```

| 参数名   | 类型   | 必填 | 说明                                                      |
| -------- | ------ | ---- | --------------------------------------------------------- |
| name     | string | 是   | 设备显示名称（1-100 字符）                                |
| platform | string | 是   | 平台类型：`linux`、`openwrt`、`macos`、`windows` 等（1-64 字符） |
| group_id | string | 否   | 初始所属分组 ID                                           |

**成功响应** (201)：

```json
{
  "code": 20000,
  "message": "Device created",
  "data": {
    "id": "dev_0123456789abcdef",
    "name": "openwrt-gw-01",
    "platform": "openwrt",
    "install_command": "cslite-agent install --server \"http://127.0.0.1:9000\" --key YOUR_API_KEY --device-id \"dev_0123456789abcdef\" --name 'openwrt-gw-01'",
    "install_commands": {
      "linux": "cslite-agent install --server \"http://127.0.0.1:9000\" --key YOUR_API_KEY --device-id \"dev_0123456789abcdef\" --name 'openwrt-gw-01'",
      "openwrt": "cslite-agent install --server \"http://127.0.0.1:9000\" --key YOUR_API_KEY --device-id \"dev_0123456789abcdef\" --name 'openwrt-gw-01'",
      "openwrt_lite": "CSLITE_SERVER=\"http://127.0.0.1:9000\" CSLITE_API_KEY=\"YOUR_API_KEY\" CSLITE_DEVICE_ID=\"dev_0123456789abcdef\" CSLITE_NAME='openwrt-gw-01' /usr/bin/cslite-agent-lite run",
      "macos": "cslite-agent install --server \"http://127.0.0.1:9000\" --key YOUR_API_KEY --device-id \"dev_0123456789abcdef\" --name 'openwrt-gw-01'",
      "windows": "cslite-agent.exe install --server \"http://127.0.0.1:9000\" --key YOUR_API_KEY --device-id \"dev_0123456789abcdef\" --name \"openwrt-gw-01\""
    },
    "expires_at": "2026-01-08T00:00:00.000Z"
  }
}
```

### `GET /api/devices` — 获取设备列表

**查询参数**：

| 参数名             | 类型   | 说明                                                       |
| ------------------ | ------ | ---------------------------------------------------------- |
| `status`           | string | 按在线状态过滤：`online` / `offline`                       |
| `group`/`group_id` | string | 分组 ID；传 `__none__` 或 `ungrouped` 过滤未分组设备       |
| `platform`         | string | 平台过滤，支持前缀匹配（如 `linux` 可匹配 `linux/amd64`）  |
| `owner`            | int    | 按所有者用户 ID 过滤（仅管理员生效）                       |
| `search`           | string | 模糊搜索 `name`、`hostname` 或 `ip_address`                |
| `page`             | int    | 页码（默认 `1`）                                           |
| `limit`/`per_page` | int    | 每页条数（默认 `20`，最大 `100`）                          |

### `GET /api/devices/status?id={device_id}` — 查询设备状态

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "OK",
  "data": {
    "id": "dev_0123456789abcdef",
    "status": "online",
    "last_updated": "2026-01-01T00:05:00.000Z",
    "metrics": {
      "cpu_usage": 12.4,
      "memory_used": 512,
      "memory_total": 2048,
      "memory_percent": 25.0,
      "disk_usage": 41.2,
      "disk_total": 20480,
      "network_in": 18,
      "network_out": 6,
      "load_avg": "0.15 0.12 0.08",
      "uptime": 86400
    }
  }
}
```

### `PATCH /api/devices/{id}` / `PUT /api/devices/{id}` — 更新设备

请求体支持 `name`、`platform`、`group_id`（传 `null` 或 `""` 可将设备移出分组）。

### `DELETE /api/devices` / `POST /api/devices/batch-delete` — 批量删除设备

```bash
curl -X DELETE http://127.0.0.1:9000/api/devices \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"ids":["dev_0123456789abcdef","dev_fedcba9876543210"]}'
```

---

## 分组接口详情

### `POST /api/groups` — 创建分组

```bash
curl -X POST http://127.0.0.1:9000/api/groups \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"name":"edge-routers","description":"OpenWrt 边缘路由"}'
```

### `PUT /api/groups/{id}/devices` 与 `DELETE /api/groups/{id}/devices`

批量将设备移入或移出分组：

```bash
curl -X PUT http://127.0.0.1:9000/api/groups/grp_0123456789abcdef/devices \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"device_ids":["dev_0123456789abcdef"]}'
```

---

## 权限说明

- 普通用户仅能查看和管理 `owner_id` 为自己（或自己创建的分组）下的设备；
- 管理员可以跨用户查看与操作所有设备与分组。

---

## 相关文档

- [权限与认证机制](./permissions.md)
- [命令与日志 API](./commands.md)
- [Agent 通信协议](../../agent/api.md)
