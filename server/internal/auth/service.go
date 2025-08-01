package auth

import (
	"errors"
	"time"

	"github.com/cslite/cslite/server/config"
	"github.com/cslite/cslite/server/models"
	"github.com/cslite/cslite/server/utils"
	"gorm.io/gorm"
)

type Service struct {
	db *gorm.DB
}

func NewService() *Service {
	return &Service{
		db: config.DB,
	}
}

func (s *Service) Login(username, password string) (*models.User, string, error) {
	var user models.User
	if err := s.db.Where("username = ?", username).First(&user).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, "", ErrInvalidCredentials
		}
		return nil, "", err
	}

	if !utils.CheckPasswordHash(password, user.Password) {
		return nil, "", ErrInvalidCredentials
	}

	token := utils.GenerateSessionToken()
	session := &models.Session{
		ID:        utils.GenerateSessionToken(),
		UserID:    user.ID,
		Token:     token,
		ExpiresAt: time.Now().Add(7 * 24 * time.Hour),
	}

	if err := s.db.Create(session).Error; err != nil {
		return nil, "", err
	}

	return &user, token, nil
}

func (s *Service) Logout(token string) error {
	return s.db.Where("token = ?", token).Delete(&models.Session{}).Error
}

func (s *Service) CreateUser(username, password, email string, role int) (*models.User, error) {
	var existingUser models.User
	if err := s.db.Where("username = ?", username).First(&existingUser).Error; err == nil {
		return nil, ErrUserExists
	}

	hashedPassword, err := utils.HashPassword(password)
	if err != nil {
		return nil, err
	}

	user := &models.User{
		Username: username,
		Password: hashedPassword,
		Email:    email,
		Role:     role,
	}

	if err := s.db.Create(user).Error; err != nil {
		return nil, err
	}

	return user, nil
}

func (s *Service) GenerateAPIKey(userID uint) (string, error) {
	apiKey := utils.GenerateAPIKey()
	
	key := &models.APIKey{
		ID:       utils.GenerateSessionToken(),
		UserID:   userID,
		Key:      apiKey,
		Name:     "Generated API Key",
		LastUsed: time.Now(),
	}

	if err := s.db.Create(key).Error; err != nil {
		return "", err
	}

	return apiKey, nil
}

func (s *Service) ValidateSession(token string) (*models.User, error) {
	var session models.Session
	if err := s.db.Where("token = ? AND expires_at > ?", token, time.Now()).First(&session).Error; err != nil {
		return nil, ErrInvalidSession
	}

	var user models.User
	if err := s.db.First(&user, session.UserID).Error; err != nil {
		return nil, err
	}

	return &user, nil
}

func (s *Service) ValidateAPIKey(key string) (*models.User, error) {
	var apiKey models.APIKey
	if err := s.db.Where("key = ?", key).First(&apiKey).Error; err != nil {
		return nil, ErrInvalidAPIKey
	}

	var user models.User
	if err := s.db.First(&user, apiKey.UserID).Error; err != nil {
		return nil, err
	}

	s.db.Model(&apiKey).Update("last_used", time.Now())

	return &user, nil
}

func (s *Service) ListUsers(page, limit int) ([]*models.User, int64, error) {
	var users []*models.User
	var total int64

	offset := (page - 1) * limit

	if err := s.db.Model(&models.User{}).Count(&total).Error; err != nil {
		return nil, 0, err
	}

	if err := s.db.Offset(offset).Limit(limit).Find(&users).Error; err != nil {
		return nil, 0, err
	}

	return users, total, nil
}

func (s *Service) DeleteUser(userID uint) error {
	return s.db.Delete(&models.User{}, userID).Error
}

func (s *Service) GetUserByID(userID uint) (*models.User, error) {
	var user models.User
	if err := s.db.First(&user, userID).Error; err != nil {
		return nil, err
	}
	return &user, nil
}