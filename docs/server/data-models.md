# 数据模型

> **最后更新**: 2025-06-20  
> **文档状态**: 正式发布

---

## ER 图

```mermaid
erDiagram
    User ||--o{ Device : owns
    User ||--o{ Command : creates
    User ||--o{ Group : creates
    Device }o--|| Group : belongs_to
    Command ||--o{ Execution : triggers
    Execution ||--o{ ExecutionResult : produces
    Device ||--o{ ExecutionResult : executes
```

---

## 核心模型

### 用户模型 `User`

```go
type User struct {
    ID        uint      `gorm:"primaryKey"`
    Username  string    `gorm:"uniqueIndex;size:50;not null"`
    Password  string    `gorm:"size:255;not null"` // bcrypt 哈希
    Email     string    `gorm:"size:100;index"`
    Role      int       `gorm:"default:0"` // 0: 普通用户, 1: 管理员
    CreatedAt time.Time
    UpdatedAt time.Time
    DeletedAt gorm.DeletedAt `gorm:"index"`
}
```

| 字段名    | 类型     | 说明           | 约束           |
| --------- | -------- | -------------- | -------------- |
| ID        | uint     | 用户唯一 ID    | 主键，自增     |
| Username  | string   | 用户名         | 唯一，非空     |
| Password  | string   | 哈希加密密码   | 非空，bcrypt   |
| Email     | string   | 邮箱地址       | 可选，索引     |
| Role      | int      | 权限角色       | 0:用户 1:管理员 |
| CreatedAt | datetime | 创建时间       | 自动设置       |
| UpdatedAt | datetime | 更新时间       | 自动更新       |
| DeletedAt | datetime | 软删除时间     | 软删除支持     |

---

### 设备模型 `Device`

```go
type Device struct {
    ID         string    `gorm:"primaryKey;size:50"`
    Name       string    `gorm:"size:100;not null"`
    Platform   string    `gorm:"size:50;not null"` // linux/amd64, windows/amd64
    OwnerID    uint      `gorm:"not null;index"`
    GroupID    string    `gorm:"size:50;index"`
    Status     string    `gorm:"size:20;default:'offline'"` // online, offline, busy
    LastSeen   time.Time
    IPAddress  string    `gorm:"size:45"` // IPv4/IPv6
    CreatedAt  time.Time
    UpdatedAt  time.Time
    DeletedAt  gorm.DeletedAt `gorm:"index"`
    
    // 关联关系
    Owner      User       `gorm:"foreignKey:OwnerID"`
    Group      Group      `gorm:"foreignKey:GroupID"`
}
```

| 字段名    | 类型     | 说明           | 约束           |
| --------- | -------- | -------------- | -------------- |
| ID        | string   | 唯一设备 ID    | 主键，自定义   |
| Name      | string   | 设备名称       | 非空           |
| Platform  | string   | 平台信息       | 非空           |
| OwnerID   | uint     | 所属用户       | 外键，非空     |
| GroupID   | string   | 所属群组       | 外键，可选     |
| Status    | string   | 在线状态       | 默认 offline   |
| LastSeen  | datetime | 最近心跳       | 可选           |
| IPAddress | string   | IP 地址        | 可选           |
| CreatedAt | datetime | 创建时间       | 自动设置       |
| UpdatedAt | datetime | 更新时间       | 自动更新       |
| DeletedAt | datetime | 软删除时间     | 软删除支持     |

---

### 群组模型 `Group`

```go
type Group struct {
    ID          string    `gorm:"primaryKey;size:50"`
    Name        string    `gorm:"size:100;not null"`
    Description string    `gorm:"size:500"`
    CreatedBy   uint      `gorm:"not null;index"`
    CreatedAt   time.Time
    UpdatedAt   time.Time
    DeletedAt   gorm.DeletedAt `gorm:"index"`
    
    // 关联关系
    Creator     User      `gorm:"foreignKey:CreatedBy"`
    Devices     []Device  `gorm:"foreignKey:GroupID"`
}
```

| 字段名      | 类型     | 说明         | 约束           |
| ----------- | -------- | ------------ | -------------- |
| ID          | string   | 群组唯一 ID  | 主键，自定义   |
| Name        | string   | 群组名称     | 非空           |
| Description | string   | 描述信息     | 可选           |
| CreatedBy   | uint     | 创建者       | 外键，非空     |
| CreatedAt   | datetime | 创建时间     | 自动设置       |
| UpdatedAt   | datetime | 更新时间     | 自动更新       |
| DeletedAt   | datetime | 软删除时间   | 软删除支持     |

---

### 命令模型 `Command`

```go
type Command struct {
    ID          string         `gorm:"primaryKey;size:50"`
    Name        string         `gorm:"size:100;not null"`
    Type        string         `gorm:"size:20;not null"` // once, cron, immediate
    Schedule    string         `gorm:"size:100"`         // cron 表达式
    Content     string         `gorm:"type:text;not null"`
    TargetType  string         `gorm:"size:20;not null"` // devices, groups
    TargetIDs   datatypes.JSON `gorm:"type:json"`        // 目标设备/群组ID列表
    Timeout     int            `gorm:"default:1800"`     // 超时时间(秒)
    RetryPolicy datatypes.JSON `gorm:"type:json"`        // 重试策略
    Status      string         `gorm:"size:20;default:'pending'"` // pending, running, completed, failed
    CreatedBy   uint           `gorm:"not null;index"`
    CreatedAt   time.Time
    UpdatedAt   time.Time
    DeletedAt   gorm.DeletedAt `gorm:"index"`
    
    // 关联关系
    Creator     User           `gorm:"foreignKey:CreatedBy"`
    Executions  []Execution    `gorm:"foreignKey:CommandID"`
}
```

| 字段名      | 类型     | 说明           | 约束           |
| ----------- | -------- | -------------- | -------------- |
| ID          | string   | 命令唯一 ID    | 主键，自定义   |
| Name        | string   | 命令名称       | 非空           |
| Type        | string   | 命令类型       | 非空           |
| Schedule    | string   | cron 表达式    | 可选           |
| Content     | text     | 命令内容       | 非空           |
| TargetType  | string   | 目标类型       | 非空           |
| TargetIDs   | json     | 目标ID列表     | JSON 格式      |
| Timeout     | int      | 超时时间       | 默认 1800 秒   |
| RetryPolicy | json     | 重试策略       | JSON 格式      |
| Status      | string   | 命令状态       | 默认 pending   |
| CreatedBy   | uint     | 创建者         | 外键，非空     |
| CreatedAt   | datetime | 创建时间       | 自动设置       |
| UpdatedAt   | datetime | 更新时间       | 自动更新       |
| DeletedAt   | datetime | 软删除时间     | 软删除支持     |

---

### 执行记录模型 `Execution`

```go
type Execution struct {
    ID         string    `gorm:"primaryKey;size:50"`
    CommandID  string    `gorm:"size:50;not null;index"`
    Status     string    `gorm:"size:20;default:'pending'"` // pending, running, completed, failed
    StartedAt  time.Time
    CompletedAt *time.Time
    CreatedAt  time.Time
    UpdatedAt  time.Time
    
    // 关联关系
    Command    Command           `gorm:"foreignKey:CommandID"`
    Results    []ExecutionResult `gorm:"foreignKey:ExecutionID"`
}
```

| 字段名      | 类型     | 说明         | 约束           |
| ----------- | -------- | ------------ | -------------- |
| ID          | string   | 执行唯一 ID  | 主键，自定义   |
| CommandID   | string   | 关联命令 ID  | 外键，非空     |
| Status      | string   | 执行状态     | 默认 pending   |
| StartedAt   | datetime | 开始时间     | 非空           |
| CompletedAt | datetime | 完成时间     | 可选           |
| CreatedAt   | datetime | 创建时间     | 自动设置       |
| UpdatedAt   | datetime | 更新时间     | 自动更新       |

---

### 执行结果模型 `ExecutionResult`

```go
type ExecutionResult struct {
    ID          string    `gorm:"primaryKey;size:50"`
    ExecutionID string    `gorm:"size:50;not null;index"`
    DeviceID    string    `gorm:"size:50;not null;index"`
    Status      string    `gorm:"size:20;not null"` // completed, failed, timeout, cancelled
    ExitCode    int       `gorm:"default:0"`
    Output      string    `gorm:"type:text"`
    LogPath     string    `gorm:"size:255"` // 日志文件路径
    StartedAt   time.Time
    CompletedAt *time.Time
    CreatedAt   time.Time
    
    // 关联关系
    Execution   Execution `gorm:"foreignKey:ExecutionID"`
    Device      Device    `gorm:"foreignKey:DeviceID"`
}
```

| 字段名      | 类型     | 说明         | 约束           |
| ----------- | -------- | ------------ | -------------- |
| ID          | string   | 结果唯一 ID  | 主键，自定义   |
| ExecutionID | string   | 关联执行 ID  | 外键，非空     |
| DeviceID    | string   | 关联设备 ID  | 外键，非空     |
| Status      | string   | 执行状态     | 非空           |
| ExitCode    | int      | 退出码       | 默认 0         |
| Output      | text     | 执行输出     | 可选           |
| LogPath     | string   | 日志路径     | 可选           |
| StartedAt   | datetime | 开始时间     | 非空           |
| CompletedAt | datetime | 完成时间     | 可选           |
| CreatedAt   | datetime | 创建时间     | 自动设置       |

---

## 索引设计

### 主键索引
- `users.id` - 用户表主键
- `devices.id` - 设备表主键
- `groups.id` - 群组表主键
- `commands.id` - 命令表主键
- `executions.id` - 执行表主键
- `execution_results.id` - 结果表主键

### 唯一索引
- `users.username` - 用户名唯一
- `devices.id` - 设备ID唯一
- `groups.id` - 群组ID唯一
- `commands.id` - 命令ID唯一

### 普通索引
- `users.email` - 邮箱查询
- `users.role` - 角色查询
- `devices.owner_id` - 设备所有者查询
- `devices.group_id` - 设备群组查询
- `devices.status` - 设备状态查询
- `devices.last_seen` - 设备心跳查询
- `groups.created_by` - 群组创建者查询
- `commands.created_by` - 命令创建者查询
- `commands.status` - 命令状态查询
- `commands.type` - 命令类型查询
- `executions.command_id` - 执行关联命令查询
- `execution_results.execution_id` - 结果关联执行查询
- `execution_results.device_id` - 结果关联设备查询

---

## 数据迁移

### 初始化迁移
```go
func AutoMigrate(db *gorm.DB) error {
    return db.AutoMigrate(
        &User{},
        &Device{},
        &Group{},
        &Command{},
        &Execution{},
        &ExecutionResult{},
    )
}
```

### 创建索引
```sql
-- 用户表索引
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

-- 设备表索引
CREATE INDEX idx_devices_owner ON devices(owner_id);
CREATE INDEX idx_devices_group ON devices(group_id);
CREATE INDEX idx_devices_status ON devices(status);
CREATE INDEX idx_devices_last_seen ON devices(last_seen);

-- 命令表索引
CREATE INDEX idx_commands_creator ON commands(created_by);
CREATE INDEX idx_commands_status ON commands(status);
CREATE INDEX idx_commands_type ON commands(type);

-- 执行表索引
CREATE INDEX idx_executions_command ON executions(command_id);
CREATE INDEX idx_executions_status ON executions(status);

-- 结果表索引
CREATE INDEX idx_results_execution ON execution_results(execution_id);
CREATE INDEX idx_results_device ON execution_results(device_id);
```

---

## 数据约束

### 外键约束
```sql
-- 设备表外键
ALTER TABLE devices ADD CONSTRAINT fk_devices_owner 
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE devices ADD CONSTRAINT fk_devices_group 
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL;

-- 群组表外键
ALTER TABLE groups ADD CONSTRAINT fk_groups_creator 
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE;

-- 命令表外键
ALTER TABLE commands ADD CONSTRAINT fk_commands_creator 
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE;

-- 执行表外键
ALTER TABLE executions ADD CONSTRAINT fk_executions_command 
    FOREIGN KEY (command_id) REFERENCES commands(id) ON DELETE CASCADE;

-- 结果表外键
ALTER TABLE execution_results ADD CONSTRAINT fk_results_execution 
    FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE;

ALTER TABLE execution_results ADD CONSTRAINT fk_results_device 
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE;
```

### 检查约束
```sql
-- 用户角色检查
ALTER TABLE users ADD CONSTRAINT chk_users_role 
    CHECK (role IN (0, 1));

-- 设备状态检查
ALTER TABLE devices ADD CONSTRAINT chk_devices_status 
    CHECK (status IN ('online', 'offline', 'busy'));

-- 命令类型检查
ALTER TABLE commands ADD CONSTRAINT chk_commands_type 
    CHECK (type IN ('once', 'cron', 'immediate'));

-- 命令状态检查
ALTER TABLE commands ADD CONSTRAINT chk_commands_status 
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'paused', 'cancelled'));

-- 执行状态检查
ALTER TABLE executions ADD CONSTRAINT chk_executions_status 
    CHECK (status IN ('pending', 'running', 'completed', 'failed'));

-- 结果状态检查
ALTER TABLE execution_results ADD CONSTRAINT chk_results_status 
    CHECK (status IN ('completed', 'failed', 'timeout', 'cancelled'));
```

---

## 计划项说明

- 数据加密、性能优化等内容详见[计划任务文档](../development/plans.md)

---

## 相关文档

- [项目概览](./overview.md) - 系统架构和核心概念
- [权限控制](./api/permissions.md) - 用户角色和权限说明
- [API 文档](./api/auth.md) - 用户认证和管理接口
- [最佳实践](../development/best-practices.md) - 数据库优化建议 