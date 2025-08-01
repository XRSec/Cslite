package models

import (
	"time"
)

type Execution struct {
	ID          string     `gorm:"primaryKey;size:50" json:"id"`
	CommandID   string     `gorm:"size:50;not null;index" json:"command_id"`
	Status      string     `gorm:"size:20;default:'pending'" json:"status"`
	StartedAt   time.Time  `json:"started_at"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`

	Command Command            `gorm:"foreignKey:CommandID" json:"command,omitempty"`
	Results []ExecutionResult  `gorm:"foreignKey:ExecutionID" json:"results,omitempty"`
}

const (
	ExecutionStatusPending   = "pending"
	ExecutionStatusRunning   = "running"
	ExecutionStatusCompleted = "completed"
	ExecutionStatusFailed    = "failed"
)

type ExecutionResult struct {
	ID          string     `gorm:"primaryKey;size:50" json:"id"`
	ExecutionID string     `gorm:"size:50;not null;index" json:"execution_id"`
	DeviceID    string     `gorm:"size:50;not null;index" json:"device_id"`
	Status      string     `gorm:"size:20;not null" json:"status"`
	ExitCode    int        `gorm:"default:0" json:"exit_code"`
	Output      string     `gorm:"type:text" json:"output,omitempty"`
	LogPath     string     `gorm:"size:255" json:"log_path,omitempty"`
	StartedAt   time.Time  `json:"started_at"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`

	Execution Execution `gorm:"foreignKey:ExecutionID" json:"-"`
	Device    Device    `gorm:"foreignKey:DeviceID" json:"device,omitempty"`
}

const (
	ResultStatusCompleted = "completed"
	ResultStatusFailed    = "failed"
	ResultStatusTimeout   = "timeout"
	ResultStatusCancelled = "cancelled"
)