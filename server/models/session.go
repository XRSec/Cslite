package models

import (
	"time"
)

type Session struct {
	ID        string    `gorm:"primaryKey;size:100" json:"id"`
	UserID    uint      `gorm:"not null;index" json:"user_id"`
	Token     string    `gorm:"size:255;uniqueIndex;not null" json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	User User `gorm:"foreignKey:UserID" json:"-"`
}

type APIKey struct {
	ID        string    `gorm:"primaryKey;size:50" json:"id"`
	UserID    uint      `gorm:"not null;index" json:"user_id"`
	Key       string    `gorm:"size:100;uniqueIndex;not null" json:"-"`
	Name      string    `gorm:"size:100" json:"name"`
	CreatedAt time.Time `json:"created_at"`
	LastUsed  time.Time `json:"last_used"`

	User User `gorm:"foreignKey:UserID" json:"-"`
}