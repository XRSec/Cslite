// models 包定义了应用程序的数据模型
package models

import (
	"time"
)

// Execution 执行记录模型，表示命令的执行实例
type Execution struct {
	ID          string     `gorm:"primaryKey;size:50" json:"id"`                    // 执行ID，主键
	CommandID   string     `gorm:"size:50;not null;index" json:"command_id"`        // 关联的命令ID
	Status      string     `gorm:"size:20;default:'pending'" json:"status"`         // 执行状态
	StartedAt   time.Time  `json:"started_at"`                                       // 开始执行时间
	CompletedAt *time.Time `json:"completed_at,omitempty"`                          // 完成时间
	CreatedAt   time.Time  `json:"created_at"`                                       // 创建时间
	UpdatedAt   time.Time  `json:"updated_at"`                                       // 更新时间

	// 关联关系
	Command Command           `gorm:"foreignKey:CommandID" json:"command,omitempty"`     // 关联的命令
	Results []ExecutionResult `gorm:"foreignKey:ExecutionID" json:"results,omitempty"`   // 执行结果列表
}

// 执行状态常量
const (
	ExecutionStatusPending   = "pending"   // 待执行状态
	ExecutionStatusRunning   = "running"   // 执行中状态
	ExecutionStatusCompleted = "completed" // 已完成状态
	ExecutionStatusFailed    = "failed"    // 执行失败状态
)

// ExecutionResult 执行结果模型，表示单个设备上的命令执行结果
type ExecutionResult struct {
	ID          string     `gorm:"primaryKey;size:50" json:"id"`                    // 结果ID，主键
	ExecutionID string     `gorm:"size:50;not null;index" json:"execution_id"`      // 关联的执行ID
	DeviceID    string     `gorm:"size:50;not null;index" json:"device_id"`         // 关联的设备ID
	Status      string     `gorm:"size:20;not null" json:"status"`                  // 执行状态
	ExitCode    int        `gorm:"default:0" json:"exit_code"`                      // 退出码
	Output      string     `gorm:"type:text" json:"output,omitempty"`               // 命令输出
	LogPath     string     `gorm:"size:255" json:"log_path,omitempty"`              // 日志文件路径
	StartedAt   time.Time  `json:"started_at"`                                       // 开始执行时间
	CompletedAt *time.Time `json:"completed_at,omitempty"`                          // 完成时间
	CreatedAt   time.Time  `json:"created_at"`                                       // 创建时间

	// 关联关系
	Execution Execution `gorm:"foreignKey:ExecutionID" json:"-"`                     // 关联的执行记录
	Device    Device    `gorm:"foreignKey:DeviceID" json:"device,omitempty"`        // 关联的设备
}

// 结果状态常量
const (
	ResultStatusPending   = "pending"   // 待执行状态
	ResultStatusCompleted = "completed" // 执行完成
	ResultStatusFailed    = "failed"    // 执行失败
	ResultStatusTimeout   = "timeout"   // 执行超时
	ResultStatusCancelled = "cancelled" // 执行取消
)