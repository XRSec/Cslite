# 权限控制

> **最后更新**: 2025-06-20  
> **文档状态**: 正式发布

---

## 权限矩阵

| 权限           | 普通用户 | 管理员 |
| -------------- | -------- | ------ |
| 添加/管理自己设备    | ✓        | ✓      |
| 查看/管理所有设备    | ✗        | ✓      |
| 执行命令 (限本身设备) | ✓        | ✓      |
| 对全部设备执行命令    | ✗        | ✓      |
| 用户管理         | ✗        | ✓      |
| 生成 API Key   | ✓        | ✓      |

---

## 用户角色

### 普通用户 (Role: 0)
**权限范围**: 仅限自己创建和管理的设备

**可执行操作**:
- ✅ 添加、编辑、删除自己的设备
- ✅ 对自己的设备执行命令
- ✅ 查看自己设备的执行日志
- ✅ 创建和管理自己的群组
- ✅ 生成个人 API Key
- ✅ 查看自己的操作历史

**限制操作**:
- ❌ 查看其他用户的设备
- ❌ 对其他用户的设备执行命令
- ❌ 管理用户账户
- ❌ 查看系统级日志

### 管理员 (Role: 1)
**权限范围**: 系统全局管理权限

**可执行操作**:
- ✅ 所有普通用户权限
- ✅ 查看和管理所有设备
- ✅ 对所有设备执行命令
- ✅ 创建、编辑、删除用户账户
- ✅ 查看系统级操作日志
- ✅ 管理全局配置
- ✅ 查看系统统计信息

---

## 权限控制实现

### 1. 认证机制

#### Session 认证
```go
// 用户登录后设置 Session
func (c *AuthController) Login(ctx *gin.Context) {
    // 验证用户名密码
    // 生成 Session Token
    // 设置 Cookie
    ctx.SetCookie("session", sessionToken, 604800, "/", "", true, true)
}
```

#### API Key 认证
```go
// API Key 验证中间件
func AuthMiddleware() gin.HandlerFunc {
    return func(c *gin.Context) {
        apiKey := c.GetHeader("X-API-Key")
        if apiKey != "" {
            // 验证 API Key
            user := validateAPIKey(apiKey)
            c.Set("user", user)
        }
        c.Next()
    }
}
```

### 2. 权限检查

#### 设备权限检查
```go
// 检查用户是否有权限操作指定设备
func checkDevicePermission(userID uint, deviceID string) bool {
    device := getDevice(deviceID)
    if device == nil {
        return false
    }
    
    // 管理员可以操作所有设备
    if isAdmin(userID) {
        return true
    }
    
    // 普通用户只能操作自己的设备
    return device.OwnerID == userID
}
```

#### 群组权限检查
```go
// 检查用户是否有权限操作指定群组
func checkGroupPermission(userID uint, groupID string) bool {
    group := getGroup(groupID)
    if group == nil {
        return false
    }
    
    // 管理员可以操作所有群组
    if isAdmin(userID) {
        return true
    }
    
    // 普通用户只能操作自己创建的群组
    return group.CreatedBy == userID
}
```

### 3. 中间件实现

#### 权限中间件
```go
func PermissionMiddleware(resource string) gin.HandlerFunc {
    return func(c *gin.Context) {
        user := c.MustGet("user").(*User)
        resourceID := c.Param("id")
        
        switch resource {
        case "device":
            if !checkDevicePermission(user.ID, resourceID) {
                c.JSON(403, gin.H{"error": "权限不足"})
                c.Abort()
                return
            }
        case "group":
            if !checkGroupPermission(user.ID, resourceID) {
                c.JSON(403, gin.H{"error": "权限不足"})
                c.Abort()
                return
            }
        }
        
        c.Next()
    }
}
```

---

## 数据隔离

### 1. 查询过滤

#### 设备列表查询
```go
func getDevices(userID uint, filters map[string]interface{}) []Device {
    query := db.Model(&Device{})
    
    // 普通用户只能看到自己的设备
    if !isAdmin(userID) {
        query = query.Where("owner_id = ?", userID)
    }
    
    // 应用其他过滤条件
    if status, ok := filters["status"]; ok {
        query = query.Where("status = ?", status)
    }
    
    var devices []Device
    query.Find(&devices)
    return devices
}
```

#### 命令列表查询
```go
func getCommands(userID uint, filters map[string]interface{}) []Command {
    query := db.Model(&Command{})
    
    // 普通用户只能看到自己创建的命令
    if !isAdmin(userID) {
        query = query.Where("created_by = ?", userID)
    }
    
    var commands []Command
    query.Find(&commands)
    return commands
}
```

### 2. 操作验证

#### 命令执行权限
```go
func executeCommand(userID uint, commandID string, targetDevices []string) error {
    command := getCommand(commandID)
    if command == nil {
        return errors.New("命令不存在")
    }
    
    // 检查命令创建权限
    if !isAdmin(userID) && command.CreatedBy != userID {
        return errors.New("权限不足")
    }
    
    // 检查目标设备权限
    for _, deviceID := range targetDevices {
        if !checkDevicePermission(userID, deviceID) {
            return errors.New("无权操作设备: " + deviceID)
        }
    }
    
    return nil
}
```

---

## 安全最佳实践

### 1. 输入验证
- 所有用户输入必须进行验证和清理
- 使用参数化查询防止 SQL 注入
- 验证文件上传类型和大小

### 2. 会话管理
- Session Token 使用强随机数生成
- 设置合理的过期时间
- 支持会话撤销

### 3. API 安全
- 使用 HTTP 传输
- 实现请求频率限制
- 记录所有敏感操作日志

### 4. 数据加密
- 密码使用 bcrypt 加密存储
- API Key 使用 SHA256 哈希
- 敏感配置信息加密存储（计划项，详见计划任务文档）

---

## 权限扩展

### 1. 自定义角色
```go
type Role struct {
    ID          uint   `gorm:"primaryKey"`
    Name        string `gorm:"uniqueIndex"`
    Permissions string // JSON 格式的权限列表
    CreatedAt   time.Time
}

type UserRole struct {
    UserID uint
    RoleID uint
}
```

### 2. 细粒度权限
```go
type Permission struct {
    Resource string // device, command, group, user
    Action   string // create, read, update, delete, execute
    Scope    string // own, all, group
}
```

---

## 相关文档

- [项目概览](../overview.md) - 系统架构和核心概念
- [数据模型](../data-models.md) - 用户和权限数据模型
- [API 文档](./auth.md) - 用户认证和管理接口
- [最佳实践](../../development/best-practices.md) - 安全部署建议 