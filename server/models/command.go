// models 包定义了应用程序的数据模型
package models

import (
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// Command 命令模型，表示要执行的命令
type Command struct {
	ID          string         `gorm:"primaryKey;size:50" json:"id"`                    // 命令ID，主键
	Name        string         `gorm:"size:100;not null" json:"name"`                   // 命令名称
	Type        string         `gorm:"size:20;not null" json:"type"`                    // 命令类型（once/cron/immediate）
	Schedule    string         `gorm:"size:100" json:"schedule,omitempty"`              // 定时表达式（cron格式，客户端执行）
	Content     string         `gorm:"type:text;not null" json:"content"`               // 命令内容
	TargetType  string         `gorm:"size:20;not null" json:"target_type"`             // 目标类型（devices/groups）
	TargetIDs   datatypes.JSON `gorm:"type:json" json:"target_ids"`                     // 目标ID列表（JSON数组）
	Timeout     int            `gorm:"default:1800" json:"timeout"`                     // 超时时间（秒）
	RetryPolicy datatypes.JSON `gorm:"type:json" json:"retry_policy,omitempty"`         // 重试策略（JSON格式）
	EnvVars     datatypes.JSON `gorm:"type:json" json:"env_vars,omitempty"`             // 环境变量（JSON格式）
	Status      string         `gorm:"size:20;default:'pending'" json:"status"`         // 命令状态
	// NextRun     *time.Time     `json:"next_run,omitempty"`                              // 下次执行时间（客户端计算）
	CreatedBy   uint           `gorm:"not null;index" json:"created_by"`                // 创建者ID
	CreatedAt   time.Time      `json:"created_at"`                                      // 创建时间
	UpdatedAt   time.Time      `json:"updated_at"`                                      // 更新时间
	DeletedAt   gorm.DeletedAt `gorm:"index" json:"-"`                                  // 软删除时间戳

	// 关联关系
	Creator    User        `gorm:"foreignKey:CreatedBy" json:"creator,omitempty"`       // 命令创建者
	Executions []Execution `gorm:"foreignKey:CommandID" json:"executions,omitempty"`    // 命令执行记录
}

// 命令类型常量
const (
	CommandTypeOnce      = "once"      // 一次性命令
	CommandTypeCron      = "cron"      // 定时命令（客户端执行）
	CommandTypeImmediate = "immediate" // 立即执行命令

	TargetTypeDevices = "devices" // 目标类型：设备
	TargetTypeGroups  = "groups"  // 目标类型：组

	CommandStatusPending   = "pending"   // 待执行状态
	CommandStatusRunning   = "running"   // 执行中状态
	CommandStatusCompleted = "completed" // 已完成状态
	CommandStatusFailed    = "failed"    // 执行失败状态
	CommandStatusPaused    = "paused"    // 暂停状态
	CommandStatusCancelled = "cancelled" // 已取消状态
)

// RetryPolicy 重试策略结构体
type RetryPolicy struct {
	Enabled     bool `json:"enabled"`     // 是否启用重试
	MaxAttempts int  `json:"max_attempts"` // 最大重试次数
}