// models 包定义了应用程序的数据模型
package models

import (
	"time"
)

// Session 会话模型，表示用户登录会话
type Session struct {
	ID        string    `gorm:"primaryKey;size:100" json:"id"`                    // 会话ID，主键
	UserID    uint      `gorm:"not null;index" json:"user_id"`                    // 用户ID
	Token     string    `gorm:"size:255;uniqueIndex;not null" json:"token"`       // 会话令牌，唯一索引
	ExpiresAt time.Time `json:"expires_at"`                                       // 过期时间
	CreatedAt time.Time `json:"created_at"`                                       // 创建时间
	UpdatedAt time.Time `json:"updated_at"`                                       // 更新时间

	// 关联关系
	User User `gorm:"foreignKey:UserID" json:"-"` // 关联的用户
}

// APIKey API密钥模型，表示用户的API访问密钥
type APIKey struct {
	ID        string    `gorm:"primaryKey;size:50" json:"id"`                     // API密钥ID，主键
	UserID    uint      `gorm:"not null;index" json:"user_id"`                    // 用户ID
	Key       string    `gorm:"size:100;uniqueIndex;not null" json:"-"`           // API密钥值，JSON中不显示
	Name      string    `gorm:"size:100" json:"name"`                             // API密钥名称
	CreatedAt time.Time `json:"created_at"`                                       // 创建时间
	LastUsed  time.Time `json:"last_used"`                                        // 最后使用时间

	// 关联关系
	User User `gorm:"foreignKey:UserID" json:"-"` // 关联的用户
}