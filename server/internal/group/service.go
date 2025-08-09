package group

import (
	"github.com/XRSec/Cslite/config"
	"github.com/XRSec/Cslite/models"
	"github.com/XRSec/Cslite/utils"
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

func (s *Service) CreateGroup(userID uint, name, description string) (*models.Group, error) {
	group := &models.Group{
		ID:          utils.GenerateGroupID(),
		Name:        name,
		Description: description,
		CreatedBy:   userID,
	}

	if err := s.db.Create(group).Error; err != nil {
		return nil, err
	}

	return group, nil
}

func (s *Service) ListGroups(userID uint, isAdmin bool) ([]*models.Group, error) {
	var groups []*models.Group

	query := s.db.Model(&models.Group{})

	if !isAdmin {
		query = query.Where("created_by = ?", userID)
	}

	if err := query.Find(&groups).Error; err != nil {
		return nil, err
	}

	for _, group := range groups {
		var deviceCount int64
		s.db.Model(&models.Device{}).Where("group_id = ?", group.ID).Count(&deviceCount)
		group.Devices = make([]models.Device, deviceCount)
	}

	return groups, nil
}

func (s *Service) AddDevicesToGroup(groupID string, deviceIDs []string, userID uint, isAdmin bool) (int64, error) {
	var group models.Group
	query := s.db

	if !isAdmin {
		query = query.Where("created_by = ?", userID)
	}

	if err := query.First(&group, "id = ?", groupID).Error; err != nil {
		return 0, err
	}

	deviceQuery := s.db.Model(&models.Device{}).Where("id IN ?", deviceIDs)

	if !isAdmin {
		deviceQuery = deviceQuery.Where("owner_id = ?", userID)
	}

	result := deviceQuery.Update("group_id", groupID)
	return result.RowsAffected, result.Error
}

func (s *Service) DeleteGroup(groupID string, userID uint, isAdmin bool) (int64, error) {
	var group models.Group

	query := s.db
	if !isAdmin {
		query = query.Where("created_by = ?", userID)
	}

	if err := query.First(&group, "id = ?", groupID).Error; err != nil {
		return 0, err
	}

	var reassignedCount int64
	s.db.Model(&models.Device{}).Where("group_id = ?", groupID).Count(&reassignedCount)

	s.db.Model(&models.Device{}).Where("group_id = ?", groupID).Update("group_id", nil)

	if err := s.db.Delete(&group).Error; err != nil {
		return 0, err
	}

	return reassignedCount, nil
}
