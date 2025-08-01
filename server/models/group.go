package models

import (
	"time"

	"gorm.io/gorm"
)

type Group struct {
	ID          string         `gorm:"primaryKey;size:50" json:"id"`
	Name        string         `gorm:"size:100;not null" json:"name"`
	Description string         `gorm:"size:500" json:"description"`
	CreatedBy   uint           `gorm:"not null;index" json:"created_by"`
	CreatedAt   time.Time      `json:"created_at"`
	UpdatedAt   time.Time      `json:"updated_at"`
	DeletedAt   gorm.DeletedAt `gorm:"index" json:"-"`

	Creator User     `gorm:"foreignKey:CreatedBy" json:"creator,omitempty"`
	Devices []Device `gorm:"foreignKey:GroupID" json:"devices,omitempty"`
}

func (g *Group) DeviceCount() int {
	return len(g.Devices)
}