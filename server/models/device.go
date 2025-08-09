// models 包定义了应用程序的数据模型
package models

import (
	"time"

	"gorm.io/gorm"
)

// Device 设备模型，表示系统中的设备
type Device struct {
	ID        string         `gorm:"primaryKey;size:50" json:"id"`           // 设备ID，主键
	Name      string         `gorm:"size:100;not null" json:"name"`          // 设备名称
	Platform  string         `gorm:"size:50;not null" json:"platform"`       // 设备平台（如Linux、Windows等）
	OwnerID   uint           `gorm:"not null;index" json:"owner_id"`         // 设备所有者ID
	GroupID   string         `gorm:"size:50;index" json:"group_id,omitempty"` // 设备所属组ID
	Status    string         `gorm:"size:20;default:'offline'" json:"status"` // 设备状态
	LastSeen  time.Time      `json:"last_seen"`                              // 最后在线时间
	IPAddress string         `gorm:"size:45" json:"ip_address,omitempty"`    // 设备IP地址
	CreatedAt time.Time      `json:"created_at"`                             // 创建时间
	UpdatedAt time.Time      `json:"updated_at"`                             // 更新时间
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`                         // 软删除时间戳

	// 关联关系
	Owner User  `gorm:"foreignKey:OwnerID" json:"owner,omitempty"`  // 设备所有者
	Group Group `gorm:"foreignKey:GroupID" json:"group,omitempty"`  // 设备所属组
}

// 设备状态常量
const (
	StatusOnline  = "online"  // 在线状态
	StatusOffline = "offline" // 离线状态
	StatusBusy    = "busy"    // 忙碌状态
)

// Agent 代理模型，表示设备上运行的代理程序
type Agent struct {
	ID              string    `gorm:"primaryKey;size:50" json:"id"`                    // 代理ID，主键
	DeviceID        string    `gorm:"size:50;uniqueIndex;not null" json:"device_id"`   // 关联的设备ID
	Version         string    `gorm:"size:20" json:"version"`                          // 代理版本
	LastHeartbeat   time.Time `json:"last_heartbeat"`                                  // 最后心跳时间
	HeartbeatMetrics string    `gorm:"type:text" json:"-"`                             // 心跳指标数据（JSON格式）
	CreatedAt       time.Time `json:"created_at"`                                      // 创建时间
	UpdatedAt       time.Time `json:"updated_at"`                                      // 更新时间

	// 关联关系
	Device Device `gorm:"foreignKey:DeviceID" json:"-"` // 关联的设备
}