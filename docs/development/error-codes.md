# 错误码参考

> **最后更新**: 2025-06-20  
> **文档状态**: 正式发布

---

## 错误响应格式

所有接口响应结构遵循统一格式：

```json
{
  "code": 40001,
  "message": "用户名或密码错误",
  "data": null
}
```

| 字段      | 类型     | 描述                     |
| --------- | -------- | ------------------------ |
| `code`    | int      | 错误编号（统一格式）     |
| `message` | string   | 中文或英文提示信息       |
| `data`    | any/null | 附加错误上下文（如字段） |

---

## 错误码分类

### 成功响应

| 错误码  | HTTP 状态 | 分类       | 含义说明                       | 建议处理方式                 |
| ------- | --------- | ---------- | ------------------------------ | ---------------------------- |
| `20000` | 200       | 通用成功   | 请求成功                       | -                            |

### 客户端错误 (4xxx)

#### 用户认证类 (40001-40009)

| 错误码  | HTTP 状态 | 分类       | 含义说明                       | 建议处理方式                 |
| ------- | --------- | ---------- | ------------------------------ | ---------------------------- |
| `40001` | 401       | 用户认证类 | 用户名或密码错误               | 提示用户重新登录             |
| `40002` | 403       | 用户权限类 | 权限不足                       | 检查用户角色是否允许该操作   |
| `40003` | 401       | Token 异常 | 登录状态失效 / Token 过期      | 强制登出，要求重新登录       |
| `40004` | 400       | 参数错误   | 请求参数无效 / 缺失            | 检查提交数据格式是否正确     |
| `40005` | 404       | 数据不存在 | 查询 ID 不存在                 | 检查是否为旧 ID 或已删除数据 |
| `40006` | 409       | 状态冲突   | 当前状态不允许该操作           | 提示用户操作顺序             |
| `40007` | 429       | 请求过快   | 超出接口限流限制               | 增加重试机制或稍后重试       |
| `40008` | 400       | 数据验证   | 数据格式或内容不符合要求       | 检查数据格式和业务规则       |
| `40009` | 409       | 资源冲突   | 资源已存在或名称重复           | 使用其他名称或 ID            |

#### 设备管理类 (40010-40019)

| 错误码  | HTTP 状态 | 分类       | 含义说明                       | 建议处理方式                 |
| ------- | --------- | ---------- | ------------------------------ | ---------------------------- |
| `40010` | 404       | 设备不存在 | 设备 ID 不存在或已删除         | 检查设备 ID 是否正确         |
| `40011` | 409       | 设备离线   | 设备当前离线，无法执行操作     | 等待设备上线后重试           |
| `40012` | 409       | 设备忙碌   | 设备正在执行其他命令           | 等待当前命令完成后重试       |
| `40013` | 400       | 设备注册   | Agent 注册失败                 | 检查 Agent 配置和网络连接    |
| `40014` | 400       | 设备分组   | 设备分组操作失败               | 检查群组 ID 和权限           |
| `40015` | 409       | 设备重复   | 设备已存在或重复注册           | 使用现有设备或更换设备名称   |

#### 命令管理类 (40020-40029)

| 错误码  | HTTP 状态 | 分类       | 含义说明                       | 建议处理方式                 |
| ------- | --------- | ---------- | ------------------------------ | ---------------------------- |
| `40020` | 404       | 命令不存在 | 命令 ID 不存在或已删除         | 检查命令 ID 是否正确         |
| `40021` | 409       | 命令状态   | 命令状态不允许该操作           | 检查命令当前状态             |
| `40022` | 400       | 命令格式   | 命令内容格式错误               | 检查命令语法和格式           |
| `40023` | 400       | 目标无效   | 命令目标设备或群组无效         | 检查目标 ID 和权限           |
| `40024` | 409       | 命令重复   | 相同命令已存在于队列中         | 避免重复提交相同命令         |
| `40025` | 400       | 超时设置   | 命令超时时间设置不合理         | 调整超时时间设置             |

#### 群组管理类 (40030-40039)

| 错误码  | HTTP 状态 | 分类       | 含义说明                       | 建议处理方式                 |
| ------- | --------- | ---------- | ------------------------------ | ---------------------------- |
| `40030` | 404       | 群组不存在 | 群组 ID 不存在或已删除         | 检查群组 ID 是否正确         |
| `40031` | 409       | 群组名称   | 群组名称已存在                 | 使用其他群组名称             |
| `40032` | 400       | 群组权限   | 无权限操作该群组               | 检查用户权限和群组归属       |
| `40033` | 409       | 群组非空   | 群组内还有设备，无法删除       | 先移除群组内设备             |

### 服务端错误 (5xxx)

#### 系统错误类 (50001-50009)

| 错误码  | HTTP 状态 | 分类       | 含义说明                       | 建议处理方式                 |
| ------- | --------- | ---------- | ------------------------------ | ---------------------------- |
| `50001` | 500       | 内部错误   | 系统异常                       | 记录日志并联系维护人员       |
| `50002` | 502       | 通信失败   | 与 Agent / DB 通信失败         | 检查网络或依赖服务健康状态   |
| `50003` | 503       | 服务不可用 | 服务暂时不可用                 | 稍后重试或联系管理员         |
| `50004` | 500       | 数据库错误 | 数据库操作失败                 | 检查数据库连接和状态         |
| `50005` | 500       | 文件操作   | 文件读写操作失败               | 检查文件权限和磁盘空间       |
| `50006` | 500       | 配置错误   | 系统配置错误                   | 检查环境变量和配置文件       |
| `50007` | 500       | 调度错误   | 任务调度器错误                 | 检查定时任务配置             |
| `50008` | 500       | 加密错误   | 数据加密/解密失败              | 检查密钥配置                 |
| `50009` | 500       | 日志错误   | 日志记录失败                   | 检查日志目录权限             |

### 业务错误 (6xxx)

#### 命令调度类 (60001-60009)

| 错误码  | HTTP 状态 | 分类       | 含义说明                       | 建议处理方式                 |
| ------- | --------- | ---------- | ------------------------------ | ---------------------------- |
| `60001` | 400       | 命令调度类 | 不支持的命令类型或目标格式错误 | 检查请求内容结构             |
| `60002` | 400       | cron 无效  | cron 表达式非法或不合理        | 用工具校验格式               |
| `60003` | 400       | 命令重复   | 同内容命令已存在于队列中       | 避免重复提交                 |
| `60004` | 400       | 执行超时   | 命令执行超时                   | 检查命令复杂度和超时设置     |
| `60005` | 400       | 执行失败   | 命令执行失败                   | 检查命令内容和目标环境       |
| `60006` | 400       | 重试失败   | 命令重试次数已达上限           | 检查网络和目标设备状态       |
| `60007` | 400       | 环境变量   | 环境变量设置错误               | 检查环境变量格式和内容       |
| `60008` | 400       | 权限不足   | 目标设备执行权限不足           | 检查用户权限和设备权限       |
| `60009` | 400       | 资源不足   | 目标设备资源不足               | 检查设备资源使用情况         |

---

## 错误处理示例

### Go 服务端错误处理

```go
// 统一错误响应结构
type ErrorResponse struct {
    Code    int         `json:"code"`
    Message string      `json:"message"`
    Data    interface{} `json:"data,omitempty"`
}

// 错误码常量
const (
    ErrSuccess           = 20000
    ErrInvalidCredentials = 40001
    ErrPermissionDenied  = 40002
    ErrTokenExpired      = 40003
    ErrInvalidParams     = 40004
    ErrNotFound          = 40005
    ErrStatusConflict    = 40006
    ErrRateLimit         = 40007
    ErrValidation        = 40008
    ErrResourceConflict  = 40009
    ErrDeviceNotFound    = 40010
    ErrDeviceOffline     = 40011
    ErrDeviceBusy        = 40012
    ErrInternal          = 50001
    ErrDatabase          = 50004
    ErrConfig            = 50006
)

// 错误信息映射
var errorMessages = map[int]string{
    ErrSuccess:           "请求成功",
    ErrInvalidCredentials: "用户名或密码错误",
    ErrPermissionDenied:  "权限不足",
    ErrTokenExpired:      "登录状态已过期",
    ErrInvalidParams:     "请求参数无效",
    ErrNotFound:          "资源不存在",
    ErrStatusConflict:    "当前状态不允许该操作",
    ErrRateLimit:         "请求过于频繁",
    ErrValidation:        "数据验证失败",
    ErrResourceConflict:  "资源已存在",
    ErrDeviceNotFound:    "设备不存在",
    ErrDeviceOffline:     "设备离线",
    ErrDeviceBusy:        "设备忙碌",
    ErrInternal:          "系统内部错误",
    ErrDatabase:          "数据库操作失败",
    ErrConfig:            "配置错误",
}

// 返回错误响应
func ErrorResponse(c *gin.Context, code int, data interface{}) {
    message := errorMessages[code]
    if message == "" {
        message = "未知错误"
    }
    
    c.JSON(getHTTPStatus(code), ErrorResponse{
        Code:    code,
        Message: message,
        Data:    data,
    })
}

// 根据错误码获取 HTTP 状态码
func getHTTPStatus(code int) int {
    switch {
    case code >= 20000 && code < 30000:
        return http.StatusOK
    case code >= 40001 && code < 40100:
        return http.StatusBadRequest
    case code >= 40100 && code < 40200:
        return http.StatusUnauthorized
    case code >= 40300 && code < 40400:
        return http.StatusForbidden
    case code >= 40400 && code < 40500:
        return http.StatusNotFound
    case code >= 40900 && code < 41000:
        return http.StatusConflict
    case code >= 42900 && code < 43000:
        return http.StatusTooManyRequests
    case code >= 50000:
        return http.StatusInternalServerError
    default:
        return http.StatusInternalServerError
    }
}
```

### 前端错误处理

```javascript
// 统一错误处理
class ErrorHandler {
    static handle(error) {
        const { code, message, data } = error;
        
        switch (code) {
            case 40001:
            case 40003:
                // 认证错误，跳转到登录页
                this.redirectToLogin();
                break;
                
            case 40002:
                // 权限不足，显示提示
                this.showPermissionError(message);
                break;
                
            case 40007:
                // 请求过快，显示提示
                this.showRateLimitError(message);
                break;
                
            case 40011:
            case 40012:
                // 设备状态错误，显示提示
                this.showDeviceStatusError(message);
                break;
                
            case 50001:
            case 50002:
                // 系统错误，显示错误页面
                this.showSystemError(message);
                break;
                
            default:
                // 其他错误，显示通用提示
                this.showGenericError(message);
        }
    }
    
    static redirectToLogin() {
        // 清除本地存储的认证信息
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        
        // 跳转到登录页
        window.location.href = '/login';
    }
    
    static showPermissionError(message) {
        // 显示权限不足提示
        this.showNotification('error', '权限不足', message);
    }
    
    static showRateLimitError(message) {
        // 显示请求过快提示
        this.showNotification('warning', '请求过快', message);
    }
    
    static showDeviceStatusError(message) {
        // 显示设备状态错误提示
        this.showNotification('warning', '设备状态', message);
    }
    
    static showSystemError(message) {
        // 显示系统错误提示
        this.showNotification('error', '系统错误', message);
    }
    
    static showGenericError(message) {
        // 显示通用错误提示
        this.showNotification('error', '操作失败', message);
    }
    
    static showNotification(type, title, message) {
        // 使用通知组件显示消息
        // 这里可以使用 Element UI、Ant Design 等 UI 库的通知组件
        console.log(`${type}: ${title} - ${message}`);
    }
}

// API 请求拦截器
axios.interceptors.response.use(
    response => response,
    error => {
        if (error.response && error.response.data) {
            const { code, message } = error.response.data;
            ErrorHandler.handle({ code, message });
        }
        return Promise.reject(error);
    }
);
```

---

## 错误日志记录

### 服务端错误日志

```go
// 错误日志记录
func logError(code int, message string, err error, context map[string]interface{}) {
    logEntry := map[string]interface{}{
        "timestamp": time.Now().Format(time.RFC3339),
        "code":      code,
        "message":   message,
        "error":     err.Error(),
        "context":   context,
    }
    
    // 记录到日志文件
    log.Printf("ERROR: %+v", logEntry)
    
    // 发送到监控系统（可选）
    if code >= 50000 {
        sendToMonitoring(logEntry)
    }
}

// 使用示例
func (c *DeviceController) GetDevice(ctx *gin.Context) {
    deviceID := ctx.Param("id")
    
    device, err := c.deviceService.GetByID(deviceID)
    if err != nil {
        logError(40010, "设备不存在", err, map[string]interface{}{
            "device_id": deviceID,
            "user_id":   ctx.GetString("user_id"),
        })
        ErrorResponse(ctx, 40010, nil)
        return
    }
    
    ctx.JSON(http.StatusOK, device)
}
```

---

## 多语言支持

### 错误信息国际化

```go
// 支持多语言的错误信息
var errorMessages = map[string]map[int]string{
    "zh-CN": {
        ErrInvalidCredentials: "用户名或密码错误",
        ErrPermissionDenied:   "权限不足",
        ErrTokenExpired:       "登录状态已过期",
        // ... 更多中文错误信息
    },
    "en-US": {
        ErrInvalidCredentials: "Invalid username or password",
        ErrPermissionDenied:   "Permission denied",
        ErrTokenExpired:       "Login session expired",
        // ... 更多英文错误信息
    },
}

// 根据 Accept-Language 头返回对应语言
func getErrorMessage(code int, lang string) string {
    if messages, ok := errorMessages[lang]; ok {
        if message, ok := messages[code]; ok {
            return message
        }
    }
    
    // 默认返回中文
    if messages, ok := errorMessages["zh-CN"]; ok {
        if message, ok := messages[code]; ok {
            return message
        }
    }
    
    return "未知错误"
}
```

---

## 相关文档

- [项目概览](../architecture/overview.md) - 系统架构和核心概念
- [环境配置](./environment.md) - 配置错误处理
- [最佳实践](./best-practices.md) - 错误处理最佳实践
- [API 文档](../api/auth.md) - 接口错误处理示例 