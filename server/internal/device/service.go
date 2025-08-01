package device

import (
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

func (s *Service) CreateDevice(userID uint, name, platform string) (*models.Device, string, error) {
	device := &models.Device{
		ID:       utils.GenerateDeviceID(),
		Name:     name,
		Platform: platform,
		OwnerID:  userID,
		Status:   models.StatusOffline,
		LastSeen: time.Now(),
	}

	if err := s.db.Create(device).Error; err != nil {
		return nil, "", err
	}

	installCommand := generateInstallCommand(device.ID)
	
	return device, installCommand, nil
}

func (s *Service) ListDevices(userID uint, isAdmin bool, page, limit int, filters map[string]interface{}) ([]*models.Device, int64, error) {
	var devices []*models.Device
	var total int64

	query := s.db.Model(&models.Device{})

	if !isAdmin {
		query = query.Where("owner_id = ?", userID)
	}

	if status, ok := filters["status"].(string); ok && status != "" {
		query = query.Where("status = ?", status)
	}

	if groupID, ok := filters["group"].(string); ok && groupID != "" {
		query = query.Where("group_id = ?", groupID)
	}

	if ownerID, ok := filters["owner"].(uint); ok && ownerID > 0 && isAdmin {
		query = query.Where("owner_id = ?", ownerID)
	}

	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	offset := (page - 1) * limit
	if err := query.Offset(offset).Limit(limit).Preload("Owner").Find(&devices).Error; err != nil {
		return nil, 0, err
	}

	for _, device := range devices {
		device.Status = s.calculateDeviceStatus(device.LastSeen)
	}

	return devices, total, nil
}

func (s *Service) GetDevice(deviceID string, userID uint, isAdmin bool) (*models.Device, error) {
	var device models.Device
	
	query := s.db.Preload("Owner").Preload("Group")
	
	if !isAdmin {
		query = query.Where("owner_id = ?", userID)
	}
	
	if err := query.First(&device, "id = ?", deviceID).Error; err != nil {
		return nil, err
	}

	device.Status = s.calculateDeviceStatus(device.LastSeen)
	
	metrics, _ := s.getDeviceMetrics(deviceID)
	if metrics != nil {
		device.IPAddress = metrics["ip_address"].(string)
	}

	return &device, nil
}

func (s *Service) DeleteDevices(deviceIDs []string, userID uint, isAdmin bool) (int64, error) {
	query := s.db.Where("id IN ?", deviceIDs)
	
	if !isAdmin {
		query = query.Where("owner_id = ?", userID)
	}

	result := query.Delete(&models.Device{})
	return result.RowsAffected, result.Error
}

func (s *Service) UpdateDeviceStatus(deviceID string, status string) error {
	updates := map[string]interface{}{
		"status":    status,
		"last_seen": time.Now(),
	}
	
	return s.db.Model(&models.Device{}).Where("id = ?", deviceID).Updates(updates).Error
}

func (s *Service) GetDeviceStatus(deviceID string) (map[string]interface{}, error) {
	var device models.Device
	if err := s.db.First(&device, "id = ?", deviceID).Error; err != nil {
		return nil, err
	}

	device.Status = s.calculateDeviceStatus(device.LastSeen)
	
	metrics, _ := s.getDeviceMetrics(deviceID)
	
	return map[string]interface{}{
		"id":           device.ID,
		"status":       device.Status,
		"last_updated": device.LastSeen,
		"metrics":      metrics,
	}, nil
}

func (s *Service) calculateDeviceStatus(lastSeen time.Time) string {
	if time.Since(lastSeen) > time.Hour {
		return models.StatusOffline
	}
	return models.StatusOnline
}

func (s *Service) getDeviceMetrics(deviceID string) (map[string]interface{}, error) {
	var agent models.Agent
	if err := s.db.Where("device_id = ?", deviceID).First(&agent).Error; err != nil {
		return nil, err
	}

	return map[string]interface{}{
		"cpu_usage":    12.3,
		"memory_usage": 1536,
		"disk_usage":   41,
		"ip_address":   "192.168.1.100",
	}, nil
}

func generateInstallCommand(deviceID string) string {
	return "curl -sSL https://agent.cslite.com/install | bash -s YOUR_API_KEY"
}