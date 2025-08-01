package models

import (
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"
)

type Command struct {
	ID          string         `gorm:"primaryKey;size:50" json:"id"`
	Name        string         `gorm:"size:100;not null" json:"name"`
	Type        string         `gorm:"size:20;not null" json:"type"`
	Schedule    string         `gorm:"size:100" json:"schedule,omitempty"`
	Content     string         `gorm:"type:text;not null" json:"content"`
	TargetType  string         `gorm:"size:20;not null" json:"target_type"`
	TargetIDs   datatypes.JSON `gorm:"type:json" json:"target_ids"`
	Timeout     int            `gorm:"default:1800" json:"timeout"`
	RetryPolicy datatypes.JSON `gorm:"type:json" json:"retry_policy,omitempty"`
	EnvVars     datatypes.JSON `gorm:"type:json" json:"env_vars,omitempty"`
	Status      string         `gorm:"size:20;default:'pending'" json:"status"`
	NextRun     *time.Time     `json:"next_run,omitempty"`
	CreatedBy   uint           `gorm:"not null;index" json:"created_by"`
	CreatedAt   time.Time      `json:"created_at"`
	UpdatedAt   time.Time      `json:"updated_at"`
	DeletedAt   gorm.DeletedAt `gorm:"index" json:"-"`

	Creator    User        `gorm:"foreignKey:CreatedBy" json:"creator,omitempty"`
	Executions []Execution `gorm:"foreignKey:CommandID" json:"executions,omitempty"`
}

const (
	CommandTypeOnce      = "once"
	CommandTypeCron      = "cron"
	CommandTypeImmediate = "immediate"

	TargetTypeDevices = "devices"
	TargetTypeGroups  = "groups"

	CommandStatusPending   = "pending"
	CommandStatusRunning   = "running"
	CommandStatusCompleted = "completed"
	CommandStatusFailed    = "failed"
	CommandStatusPaused    = "paused"
	CommandStatusCancelled = "cancelled"
)

type RetryPolicy struct {
	Enabled     bool `json:"enabled"`
	MaxAttempts int  `json:"max_attempts"`
}