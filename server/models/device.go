package models

import (
	"time"

	"gorm.io/gorm"
)

type Device struct {
	ID        string         `gorm:"primaryKey;size:50" json:"id"`
	Name      string         `gorm:"size:100;not null" json:"name"`
	Platform  string         `gorm:"size:50;not null" json:"platform"`
	OwnerID   uint           `gorm:"not null;index" json:"owner_id"`
	GroupID   string         `gorm:"size:50;index" json:"group_id,omitempty"`
	Status    string         `gorm:"size:20;default:'offline'" json:"status"`
	LastSeen  time.Time      `json:"last_seen"`
	IPAddress string         `gorm:"size:45" json:"ip_address,omitempty"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`

	Owner User  `gorm:"foreignKey:OwnerID" json:"owner,omitempty"`
	Group Group `gorm:"foreignKey:GroupID" json:"group,omitempty"`
}

const (
	StatusOnline  = "online"
	StatusOffline = "offline"
	StatusBusy    = "busy"
)

type Agent struct {
	ID              string    `gorm:"primaryKey;size:50" json:"id"`
	DeviceID        string    `gorm:"size:50;uniqueIndex;not null" json:"device_id"`
	Version         string    `gorm:"size:20" json:"version"`
	LastHeartbeat   time.Time `json:"last_heartbeat"`
	HeartbeatMetrics string    `gorm:"type:text" json:"-"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`

	Device Device `gorm:"foreignKey:DeviceID" json:"-"`
}