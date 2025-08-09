// models 包定义了应用程序的数据模型
package models

import (
	"time"

	"gorm.io/gorm"
)

// User 用户模型，表示系统中的用户账户
type User struct {
	ID        uint           `gorm:"primaryKey" json:"id"`                    // 用户ID，主键
	Username  string         `gorm:"uniqueIndex;size:50;not null" json:"username"` // 用户名，唯一索引
	Password  string         `gorm:"size:255;not null" json:"-"`              // 密码哈希，JSON中不显示
	Email     string         `gorm:"size:100;index" json:"email"`             // 邮箱地址
	Role      int            `gorm:"default:0" json:"role"`                   // 用户角色
	CreatedAt time.Time      `json:"created_at"`                             // 创建时间
	UpdatedAt time.Time      `json:"updated_at"`                             // 更新时间
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`                         // 软删除时间戳

	// 关联关系
	Devices  []Device  `gorm:"foreignKey:OwnerID" json:"-"`  // 用户拥有的设备
	Commands []Command `gorm:"foreignKey:CreatedBy" json:"-"` // 用户创建的命令
	Groups   []Group   `gorm:"foreignKey:CreatedBy" json:"-"` // 用户创建的组
}

// 用户角色常量
const (
	RoleUser  = 0 // 普通用户角色
	RoleAdmin = 1 // 管理员角色
)

// IsAdmin 检查用户是否为管理员
func (u *User) IsAdmin() bool {
	return u.Role == RoleAdmin
}