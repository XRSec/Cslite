// auth 包提供了用户认证相关的服务
package auth

import (
	"errors"
	"time"

	"github.com/XRSec/Cslite/config"
	"github.com/XRSec/Cslite/models"
	"github.com/XRSec/Cslite/utils"
	"gorm.io/gorm"
)

// Service 认证服务结构体
type Service struct{}

// NewService 创建新的认证服务实例
func NewService() *Service { return &Service{} }

// Login 用户登录
func (s *Service) Login(username, password string) (*models.User, string, error) {
	var user models.User
	// 根据用户名查找用户
	if err := config.DB.Where("username = ?", username).First(&user).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, "", ErrInvalidCredentials
		}
		return nil, "", err
	}

	// 验证密码
	if !utils.CheckPasswordHash(password, user.Password) {
		return nil, "", ErrInvalidCredentials
	}

	// 生成会话令牌
	token := utils.GenerateSessionToken()
	session := &models.Session{
		ID:        utils.GenerateSessionToken(),
		UserID:    user.ID,
		Token:     token,
		ExpiresAt: time.Now().Add(7 * 24 * time.Hour), // 7天后过期
	}

	// 创建会话记录
	if err := config.DB.Create(session).Error; err != nil {
		return nil, "", err
	}

	return &user, token, nil
}

// Logout 用户登出
func (s *Service) Logout(token string) error {
	// 删除会话记录
	return config.DB.Where("token = ?", token).Delete(&models.Session{}).Error
}

// CreateUser 创建新用户
func (s *Service) CreateUser(username, password, email string, role int) (*models.User, error) {
	var existingUser models.User
	// 检查用户名是否已存在
	if err := config.DB.Where("username = ?", username).First(&existingUser).Error; err == nil {
		return nil, ErrUserExists
	}

	// 对密码进行哈希加密
	hashedPassword, err := utils.HashPassword(password)
	if err != nil {
		return nil, err
	}

	// 创建新用户
	user := &models.User{
		Username: username,
		Password: hashedPassword,
		Email:    email,
		Role:     role,
	}

	if err := config.DB.Create(user).Error; err != nil {
		return nil, err
	}

	return user, nil
}

// GenerateAPIKey 为用户生成API密钥
func (s *Service) GenerateAPIKey(userID uint) (string, error) {
	apiKey := utils.GenerateAPIKey()

	// 创建API密钥记录
	key := &models.APIKey{
		ID:       utils.GenerateSessionToken(),
		UserID:   userID,
		Key:      apiKey,
		Name:     "Generated API Key",
		LastUsed: time.Now(),
	}

	if err := config.DB.Create(key).Error; err != nil {
		return "", err
	}

	return apiKey, nil
}

// ValidateSession 验证会话令牌
func (s *Service) ValidateSession(token string) (*models.User, error) {
	var session models.Session
	// 查找未过期的会话
	if err := config.DB.Where("token = ? AND expires_at > ?", token, time.Now()).First(&session).Error; err != nil {
		return nil, ErrInvalidSession
	}

	// 获取用户信息
	var user models.User
	if err := config.DB.First(&user, session.UserID).Error; err != nil {
		return nil, err
	}

	return &user, nil
}

// ValidateAPIKey 验证API密钥
func (s *Service) ValidateAPIKey(key string) (*models.User, error) {
	var apiKey models.APIKey
	// 查找API密钥
	if err := config.DB.Where("key = ?", key).First(&apiKey).Error; err != nil {
		return nil, ErrInvalidAPIKey
	}

	// 获取用户信息
	var user models.User
	if err := config.DB.First(&user, apiKey.UserID).Error; err != nil {
		return nil, err
	}

	// 更新最后使用时间
	config.DB.Model(&apiKey).Update("last_used", time.Now())

	return &user, nil
}

// ListUsers 分页列出用户
func (s *Service) ListUsers(page, limit int) ([]*models.User, int64, error) {
	var users []*models.User
	var total int64

	offset := (page - 1) * limit

	// 获取总用户数
	if err := config.DB.Model(&models.User{}).Count(&total).Error; err != nil {
		return nil, 0, err
	}

	// 分页查询用户列表
	if err := config.DB.Offset(offset).Limit(limit).Find(&users).Error; err != nil {
		return nil, 0, err
	}

	return users, total, nil
}

// DeleteUser 删除用户
func (s *Service) DeleteUser(userID uint) error {
	return config.DB.Delete(&models.User{}, userID).Error
}

// GetUserByID 根据ID获取用户
func (s *Service) GetUserByID(userID uint) (*models.User, error) {
	var user models.User
	if err := config.DB.First(&user, userID).Error; err != nil {
		return nil, err
	}
	return &user, nil
}
