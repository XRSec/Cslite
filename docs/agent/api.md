# Agent 接口

> **最后更新**: 2025-06-20  
> **文档状态**: 正式发布

---

## 接口概览

| 接口 | 方法 | 路径 | 描述 | 认证 |
|------|------|------|------|------|
| Agent 注册 | POST | `/agent/register` | 初次安装后注册设备 | API Key |
| 心跳签到 | POST | `/agent/heartbeat` | 定期上报在线状态 | API Key |
| 拉取命令 | GET | `/agent/commands` | 轮询获取待执行命令 | API Key |
| 上报结果 | POST | `/agent/result` | 上报命令执行结果 | API Key |

---

## Agent 注册

### `POST /agent/register`

初次安装后调用，绑定设备、生成 Agent ID。

**请求参数**：

```json
{
  "name": "ubuntu-node-01",
  "platform": "linux/amd64",
  "version": "v3.3.1"
}
```

| 参数名   | 类型   | 必填 | 说明                    |
| -------- | ------ | ---- | ----------------------- |
| name     | string | 是   | 设备名称（1-100字符）   |
| platform | string | 是   | 平台信息（如 linux/amd64） |
| version  | string | 是   | Agent 版本号            |

**请求头**：

```
X-API-Key: ak_live_abc123def456
```

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "注册成功",
  "data": {
    "agent_id": "agent_abc123",
    "device_id": "dev_xyz123",
    "heartbeat_interval": 60
  }
}
```

**错误响应**：

| 错误码 | HTTP 状态 | 说明           |
| ------ | --------- | -------------- |
| 40013  | 400       | Agent 注册失败 |
| 40004  | 400       | 参数缺失或格式错误 |
| 40015  | 409       | 设备已存在或重复注册 |

**示例**：

```bash
curl -X POST https://api.cslite.com/agent/register \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ak_live_abc123def456" \
  -d '{
    "name": "ubuntu-node-01",
    "platform": "linux/amd64",
    "version": "v3.3.1"
  }'
```

---

## 心跳签到

### `POST /agent/heartbeat`

每 60 秒调用一次，用于报告在线状态。

**请求参数**：

```json
{
  "agent_id": "agent_abc123",
  "metrics": {
    "cpu_usage": 10.5,
    "memory_used": 1536,
    "disk_usage": 42.7
  },
  "timestamp": "2025-06-20T15:01:00Z"
}
```

| 参数名    | 类型   | 必填 | 说明                    |
| --------- | ------ | ---- | ----------------------- |
| agent_id  | string | 是   | Agent ID                |
| metrics   | object | 否   | 系统指标数据            |
| timestamp | string | 否   | 心跳时间戳（ISO 8601）  |

**metrics 字段说明**：

| 字段名      | 类型   | 单位 | 说明           |
| ----------- | ------ | ---- | -------------- |
| cpu_usage   | float  | %    | CPU 使用率     |
| memory_used | int    | MB   | 内存使用量     |
| disk_usage  | float  | %    | 磁盘使用率     |
| network_in  | int    | KB/s | 网络入流量     |
| network_out | int    | KB/s | 网络出流量     |

**请求头**：

```
X-API-Key: ak_live_abc123def456
```

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "心跳成功",
  "data": {
    "status": "ok",
    "next_heartbeat": "2025-06-20T15:02:00Z"
  }
}
```

**错误响应**：

| 错误码 | HTTP 状态 | 说明           |
| ------ | --------- | -------------- |
| 40010  | 404       | 设备不存在     |
| 40004  | 400       | 参数缺失或格式错误 |

**示例**：

```bash
curl -X POST https://api.cslite.com/agent/heartbeat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ak_live_abc123def456" \
  -d '{
    "agent_id": "agent_abc123",
    "metrics": {
      "cpu_usage": 10.5,
      "memory_used": 1536,
      "disk_usage": 42.7
    },
    "timestamp": "2025-06-20T15:01:00Z"
  }'
```

---

## 拉取命令

### `GET /agent/commands`

Agent 每 30 秒查询一次，有新任务则返回。

**查询参数**：

| 参数名    | 类型   | 必填 | 说明     |
| --------- | ------ | ---- | -------- |
| agent_id  | string | 是   | Agent ID |

**请求头**：

```
X-API-Key: ak_live_abc123def456
```

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "获取成功",
  "data": {
    "commands": [
      {
        "command_id": "cmd_abc123",
        "execution_id": "exec_abc123",
        "content": "df -h",
        "timeout": 600,
        "env_vars": {
          "LANG": "en_US.UTF-8"
        }
      }
    ]
  }
}
```

**无命令响应** (200)：

```json
{
  "code": 20000,
  "message": "获取成功",
  "data": {
    "commands": []
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
curl -X GET "https://api.cslite.com/agent/commands?agent_id=agent_abc123" \
  -H "X-API-Key: ak_live_abc123def456"
```

---

## 上报命令执行结果

### `POST /agent/result`

上报命令执行结果。

**请求参数**：

```json
{
  "execution_id": "exec_abc123",
  "device_id": "dev_xyz123",
  "status": "completed",
  "exit_code": 0,
  "output": "Filesystem usage:\n/dev/sda1 80%",
  "log": "base64-encoded-log-content",
  "completed_at": "2025-06-20T15:05:00Z"
}
```

| 参数名       | 类型   | 必填 | 说明                    |
| ------------ | ------ | ---- | ----------------------- |
| execution_id | string | 是   | 执行 ID                 |
| device_id    | string | 是   | 设备 ID                 |
| status       | string | 是   | 执行状态                |
| exit_code    | int    | 否   | 退出码                  |
| output       | string | 否   | 命令输出                |
| log          | string | 否   | 详细日志（Base64编码）  |
| completed_at | string | 否   | 完成时间（ISO 8601）    |

**状态字段说明**：

| 状态      | 描述       |
| --------- | ---------- |
| completed | 正常完成   |
| failed    | 执行失败   |
| timeout   | 超时未完成 |
| cancelled | 已被取消   |

**请求头**：

```
X-API-Key: ak_live_abc123def456
```

**成功响应** (200)：

```json
{
  "code": 20000,
  "message": "结果上报成功",
  "data": {
    "status": "received",
    "logged": true
  }
}
```

**错误响应**：

| 错误码 | HTTP 状态 | 说明           |
| ------ | --------- | -------------- |
| 40004  | 400       | 参数缺失或格式错误 |
| 40010  | 404       | 设备不存在     |
| 40020  | 404       | 命令不存在     |

**示例**：

```bash
curl -X POST https://api.cslite.com/agent/result \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ak_live_abc123def456" \
  -d '{
    "execution_id": "exec_abc123",
    "device_id": "dev_xyz123",
    "status": "completed",
    "exit_code": 0,
    "output": "Filesystem usage:\n/dev/sda1 80%",
    "completed_at": "2025-06-20T15:05:00Z"
  }'
```

---

## 通信协议

### 1. 认证方式

**API Key 认证**：
```bash
# 在请求头中携带 API Key
X-API-Key: ak_live_abc123def456
```

**API Key 格式**：
- 前缀：`ak_live_`
- 长度：32 字符
- 字符集：字母、数字、下划线

### 2. 数据格式

**请求格式**：
- Content-Type: `application/json`
- 字符编码：UTF-8
- 时间格式：ISO 8601

**响应格式**：
```json
{
  "code": 20000,
  "message": "操作成功",
  "data": {}
}
```

### 3. 错误处理

**网络错误**：
```go
// 重试机制
func retryRequest(fn func() error, maxRetries int) error {
    for i := 0; i < maxRetries; i++ {
        if err := fn(); err == nil {
            return nil
        }
        time.Sleep(time.Duration(i+1) * time.Second)
    }
    return errors.New("重试次数已达上限")
}
```

**超时处理**：
```go
// 设置请求超时
client := &http.Client{
    Timeout: 30 * time.Second,
}
```

---

## Agent 实现示例

### Go Agent 示例

```go
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "net/http"
    "time"
)

type Agent struct {
    ID       string
    Server   string
    APIKey   string
    Interval time.Duration
}

type RegisterRequest struct {
    Name     string `json:"name"`
    Platform string `json:"platform"`
    Version  string `json:"version"`
}

type HeartbeatRequest struct {
    AgentID  string                 `json:"agent_id"`
    Metrics  map[string]interface{} `json:"metrics"`
    Timestamp string                `json:"timestamp"`
}

type CommandResponse struct {
    Commands []Command `json:"commands"`
}

type Command struct {
    CommandID   string            `json:"command_id"`
    ExecutionID string            `json:"execution_id"`
    Content     string            `json:"content"`
    Timeout     int               `json:"timeout"`
    EnvVars     map[string]string `json:"env_vars"`
}

func (a *Agent) Register() error {
    req := RegisterRequest{
        Name:     "ubuntu-node-01",
        Platform: "linux/amd64",
        Version:  "v3.3.1",
    }
    
    data, _ := json.Marshal(req)
    resp, err := http.Post(a.Server+"/agent/register", "application/json", bytes.NewBuffer(data))
    if err != nil {
        return err
    }
    defer resp.Body.Close()
    
    // 处理响应...
    return nil
}

func (a *Agent) Heartbeat() error {
    metrics := map[string]interface{}{
        "cpu_usage":    getCPUUsage(),
        "memory_used":  getMemoryUsage(),
        "disk_usage":   getDiskUsage(),
    }
    
    req := HeartbeatRequest{
        AgentID:  a.ID,
        Metrics:  metrics,
        Timestamp: time.Now().Format(time.RFC3339),
    }
    
    data, _ := json.Marshal(req)
    resp, err := http.Post(a.Server+"/agent/heartbeat", "application/json", bytes.NewBuffer(data))
    if err != nil {
        return err
    }
    defer resp.Body.Close()
    
    return nil
}

func (a *Agent) PollCommands() ([]Command, error) {
    resp, err := http.Get(fmt.Sprintf("%s/agent/commands?agent_id=%s", a.Server, a.ID))
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()
    
    var result CommandResponse
    json.NewDecoder(resp.Body).Decode(&result)
    
    return result.Commands, nil
}

func (a *Agent) ReportResult(executionID, deviceID, status string, exitCode int, output string) error {
    req := map[string]interface{}{
        "execution_id": executionID,
        "device_id":    deviceID,
        "status":       status,
        "exit_code":    exitCode,
        "output":       output,
        "completed_at": time.Now().Format(time.RFC3339),
    }
    
    data, _ := json.Marshal(req)
    resp, err := http.Post(a.Server+"/agent/result", "application/json", bytes.NewBuffer(data))
    if err != nil {
        return err
    }
    defer resp.Body.Close()
    
    return nil
}

func (a *Agent) Run() {
    // 注册
    if err := a.Register(); err != nil {
        log.Fatal("注册失败:", err)
    }
    
    // 心跳循环
    go func() {
        ticker := time.NewTicker(a.Interval * time.Second)
        for range ticker.C {
            if err := a.Heartbeat(); err != nil {
                log.Printf("心跳失败: %v", err)
            }
        }
    }()
    
    // 命令轮询循环
    go func() {
        ticker := time.NewTicker(30 * time.Second)
        for range ticker.C {
            commands, err := a.PollCommands()
            if err != nil {
                log.Printf("轮询命令失败: %v", err)
                continue
            }
            
            for _, cmd := range commands {
                go a.ExecuteCommand(cmd)
            }
        }
    }()
    
    // 保持运行
    select {}
}

func (a *Agent) ExecuteCommand(cmd Command) {
    // 执行命令
    output, exitCode, err := executeShellCommand(cmd.Content, cmd.Timeout, cmd.EnvVars)
    
    status := "completed"
    if err != nil {
        status = "failed"
    }
    
    // 上报结果
    a.ReportResult(cmd.ExecutionID, a.ID, status, exitCode, output)
}
```

---

## 最佳实践

### 1. 错误处理

- 实现指数退避重试机制
- 记录详细的错误日志
- 区分网络错误和业务错误

### 2. 性能优化

- 使用连接池复用 HTTP 连接
- 压缩请求和响应数据
- 合理设置超时时间

### 3. 安全性

- 定期轮换 API Key
- 验证服务端证书
- 加密敏感数据传输

---

## 相关文档

- [Agent 部署](./deployment.md) - Agent 安装和配置
- [环境配置](../development/environment.md) - Agent 环境变量
- [错误码参考](../development/error-codes.md) - 错误处理
- [设备管理](../server/api/devices.md) - 设备管理接口 