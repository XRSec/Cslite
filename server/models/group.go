// models 包定义了应用程序的数据模型
package models

import (
	"time"

	"gorm.io/gorm"
)

// Group 组模型，表示设备分组
type Group struct {
	ID          string         `gorm:"primaryKey;size:50" json:"id"`           // 组ID，主键
	Name        string         `gorm:"size:100;not null" json:"name"`          // 组名称
	Description string         `gorm:"size:500" json:"description"`            // 组描述
	CreatedBy   uint           `gorm:"not null;index" json:"created_by"`       // 创建者ID
	CreatedAt   time.Time      `json:"created_at"`                             // 创建时间
	UpdatedAt   time.Time      `json:"updated_at"`                             // 更新时间
	DeletedAt   gorm.DeletedAt `gorm:"index" json:"-"`                         // 软删除时间戳

	// 关联关系
	Creator User     `gorm:"foreignKey:CreatedBy" json:"creator,omitempty"` // 组创建者
	Devices []Device `gorm:"foreignKey:GroupID" json:"devices,omitempty"`   // 组内设备列表
}

// DeviceCount 返回组内设备数量
func (g *Group) DeviceCount() int {
	return len(g.Devices)
}