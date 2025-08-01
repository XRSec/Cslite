package models

import (
	"time"

	"gorm.io/gorm"
)

type User struct {
	ID        uint           `gorm:"primaryKey" json:"id"`
	Username  string         `gorm:"uniqueIndex;size:50;not null" json:"username"`
	Password  string         `gorm:"size:255;not null" json:"-"`
	Email     string         `gorm:"size:100;index" json:"email"`
	Role      int            `gorm:"default:0" json:"role"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`

	Devices  []Device  `gorm:"foreignKey:OwnerID" json:"-"`
	Commands []Command `gorm:"foreignKey:CreatedBy" json:"-"`
	Groups   []Group   `gorm:"foreignKey:CreatedBy" json:"-"`
}

const (
	RoleUser  = 0
	RoleAdmin = 1
)

func (u *User) IsAdmin() bool {
	return u.Role == RoleAdmin
}