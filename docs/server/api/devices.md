# 设备管理 API

> **最后更新**: 2025-06-20  
> **文档状态**: 正式发布

---

## 接口概览

| 接口 | 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|------|
| 添加设备 | POST | `/devices` | 添加新设备 | 需要登录 |
| 获取设备列表 | GET | `/devices` | 获取设备列表 | 需要登录 |
| 获取设备详情 | GET | `/devices/{id}` | 获取设备详细信息 | 需要登录 |
| 查询设备状态 | GET | `/devices/status` | 查询设备在线状态 | 需要登录 |
| 批量删除设备 | DELETE | `/devices` | 批量删除设备 | 需要登录 |

---

## 添加设备

### `POST /devices`

添加新设备，生成安装命令。

**请求参数**：

```json
{
  "name": "Production Server",
  "platform": "linux/amd64"
}
```

| 参数名   | 类型   | 必填 | 说明                    |
| -------- | ------ | ---- | ----------------------- |
| name     | string | 是   | 设备名称（1-100字符）   |
| platform | string | 是   | 平台信息（如 linux/amd64） |

**成功响应** (201)：

```json
{
  "code": 20000,
  "message": "设备添加成功",
  "data": {
    "id": "dev_abc123",
    "name": "Production Server",
    "platform": "linux/amd64",
    "install_command": "curl -sSL https://agent.cslite.com/install | bash -s YOUR_API_KEY",
    "expires_at": "2025-06-27T12:00:00Z"
  }
}
```

**错误响应**：

| 错误码 | HTTP 状态 | 说明           |
| ------ | --------- | -------------- |
| 40004  | 400       | 参数缺失或格式错误 |
| 40008  | 400       | 数据验证失败   |
| 40009  | 409       | 设备名称已存在 |

**示例**：

```bash
curl -X POST https://api.cslite.com/devices \
  -H "Content-Type: application/json" \
  -H "Cookie: session=sess_abc123def456" \
  -d '{
    "name": "Production Server",
    "platform": "linux/amd64"
  }'
```

---

## 获取设备列表

### `GET /devices`

获取设备列表，支持分页和过滤。

**查询参数**：

| 参数名 | 类型   | 必填 | 说明                    |
| ------ | ------ | ---- | ----------------------- |
| status | string | 否   | 在线状态 (online/offline) |
| group  | string | 否   | 群组ID                  |
| owner  | int    | 否   | 用户ID（仅管理员）      |
| page   | int    | 否   | 页码（默认1）           |
| limit  | int    | 否   | 每页数量（默认20）      |
| search | string | 否   | 设备名称搜索            |

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "获取成功",
  "data": {
    "total": 15,
    "page": 1,
    "per_page": 5,
    "devices": [
      {
        "id": "dev_abc123",
        "name": "Production Server",
        "platform": "linux/amd64",
        "status": "online",
        "owner_id": 1001,
        "group_id": "grp_001",
        "last_seen": "2025-06-20T12:30:00Z",
        "ip_address": "192.168.1.100"
      },
      {
        "id": "dev_def456",
        "name": "Test Server",
        "platform": "linux/amd64",
        "status": "offline",
        "owner_id": 1001,
        "group_id": null,
        "last_seen": "2025-06-19T18:45:00Z",
        "ip_address": "192.168.1.101"
      }
    ]
  }
}
```

**错误响应**：

| 错误码 | HTTP 状态 | 说明           |
| ------ | --------- | -------------- |
| 40003  | 401       | 登录状态已过期 |
| 40004  | 400       | 参数格式错误   |

**示例**：

```bash
curl -X GET "https://api.cslite.com/devices?status=online&page=1&limit=10" \
  -H "Cookie: session=sess_abc123def456"
```

---

## 获取设备详情

### `GET /devices/{id}`

获取指定设备的详细信息。

**路径参数**：

| 参数名 | 类型   | 必填 | 说明   |
| ------ | ------ | ---- | ------ |
| id     | string | 是   | 设备ID |

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "获取成功",
  "data": {
    "id": "dev_abc123",
    "name": "Production Server",
    "platform": "linux/amd64",
    "status": "online",
    "metrics": {
      "cpu_usage": 15.3,
      "memory_used": 2048,
      "disk_usage": 45.2
    },
    "owner_id": 1001,
    "group_id": "grp_001",
    "created_at": "2025-06-15T09:00:00Z",
    "last_seen": "2025-06-20T12:30:00Z",
    "ip_address": "192.168.1.100"
  }
}
```

**错误响应**：

| 错误码 | HTTP 状态 | 说明           |
| ------ | --------- | -------------- |
| 40010  | 404       | 设备不存在     |
| 40002  | 403       | 权限不足       |

**示例**：

```bash
curl -X GET https://api.cslite.com/devices/dev_abc123 \
  -H "Cookie: session=sess_abc123def456"
```

---

## 查询设备状态

### `GET /devices/status`

查询指定设备的在线状态和指标。

**查询参数**：

| 参数名 | 类型   | 必填 | 说明   |
| ------ | ------ | ---- | ------ |
| id     | string | 是   | 设备ID |

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "查询成功",
  "data": {
    "id": "dev_abc123",
    "status": "online",
    "last_updated": "2025-06-20T13:00:00Z",
    "metrics": {
      "cpu_usage": 12.3,
      "memory_usage": 1536,
      "disk_usage": 41
    }
  }
}
```

**错误响应**：

| 错误码 | HTTP 状态 | 说明           |
| ------ | --------- | -------------- |
| 40010  | 404       | 设备不存在     |
| 40011  | 409       | 设备离线       |

**示例**：

```bash
curl -X GET "https://api.cslite.com/devices/status?id=dev_abc123" \
  -H "Cookie: session=sess_abc123def456"
```

---

## 批量删除设备

### `DELETE /devices`

批量删除设备。

**请求参数**：

```json
{
  "ids": ["dev_abc123", "dev_def456"]
}
```

| 参数名 | 类型     | 必填 | 说明     |
| ------ | -------- | ---- | -------- |
| ids    | string[] | 是   | 设备ID列表 |

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "删除成功",
  "data": {
    "deleted_count": 2
  }
}
```

**错误响应**：

| 错误码 | HTTP 状态 | 说明           |
| ------ | --------- | -------------- |
| 40004  | 400       | 参数缺失或格式错误 |
| 40010  | 404       | 部分设备不存在 |
| 40002  | 403       | 权限不足       |

**示例**：

```bash
curl -X DELETE https://api.cslite.com/devices \
  -H "Content-Type: application/json" \
  -H "Cookie: session=sess_abc123def456" \
  -d '{
    "ids": ["dev_abc123", "dev_def456"]
  }'
```

---

## 设备状态说明

### 在线状态

| 状态      | 描述        | 判断条件                    |
| --------- | ----------- | --------------------------- |
| online    | 在线        | 最近1小时内有心跳签到      |
| offline   | 离线        | 超过1小时未心跳签到        |
| busy      | 忙碌        | 当前正在执行命令            |

### 设备指标

| 指标名        | 类型   | 单位 | 说明           |
| ------------- | ------ | ---- | -------------- |
| cpu_usage     | float  | %    | CPU 使用率     |
| memory_used   | int    | MB   | 内存使用量     |
| memory_usage  | float  | %    | 内存使用率     |
| disk_usage    | float  | %    | 磁盘使用率     |
| network_in    | int    | KB/s | 网络入流量     |
| network_out   | int    | KB/s | 网络出流量     |

---

## 设备分组

### 设备分组操作

设备可以分配到不同的群组中进行管理：

```bash
# 将设备添加到群组
curl -X PUT https://api.cslite.com/groups/grp_001/devices \
  -H "Content-Type: application/json" \
  -H "Cookie: session=sess_abc123def456" \
  -d '{
    "device_ids": ["dev_abc123", "dev_def456"]
  }'

# 从群组中移除设备
curl -X DELETE https://api.cslite.com/groups/grp_001/devices \
  -H "Content-Type: application/json" \
  -H "Cookie: session=sess_abc123def456" \
  -d '{
    "device_ids": ["dev_abc123"]
  }'
```

---

## 权限说明

### 设备权限

| 操作 | 普通用户 | 管理员 | 说明 |
|------|----------|--------|------|
| 查看自己的设备 | ✓ | ✓ | 只能查看自己创建的设备 |
| 查看所有设备 | ✗ | ✓ | 管理员可以查看所有设备 |
| 添加设备 | ✓ | ✓ | 都可以添加设备 |
| 删除自己的设备 | ✓ | ✓ | 只能删除自己的设备 |
| 删除所有设备 | ✗ | ✓ | 管理员可以删除所有设备 |

### 设备归属

- 设备创建后归属于创建者
- 普通用户只能管理自己创建的设备
- 管理员可以管理所有设备
- 设备可以分配给不同的群组

---

## 设备生命周期

### 1. 设备注册

```
用户创建设备 → 生成安装命令 → Agent 安装 → 设备注册 → 状态更新
```

### 2. 设备运行

```
Agent 心跳 → 状态更新 → 命令执行 → 结果上报 → 日志记录
```

### 3. 设备下线

```
心跳超时 → 状态标记为离线 → 清理资源 → 可选删除
```

---

## 最佳实践

### 1. 设备命名

- 使用有意义的名称，如 `web-server-01`
- 包含环境信息，如 `prod-db-master`
- 避免使用特殊字符

### 2. 设备监控

- 定期检查设备在线状态
- 监控设备资源使用情况
- 设置告警阈值

### 3. 设备管理

- 合理使用设备分组
- 定期清理离线设备
- 备份重要设备配置

---

## 相关文档

- [权限控制](./permissions.md) - 用户角色和权限说明
- [群组管理](./groups.md) - 设备分组管理
- [命令管理](./commands.md) - 设备命令执行
- [Agent 接口](../agent/api.md) - Agent 通信接口 