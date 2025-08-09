// device 包提供了设备管理相关的服务
package device

import (
	"time"

	"github.com/XRSec/Cslite/config"
	"github.com/XRSec/Cslite/models"
	"github.com/XRSec/Cslite/utils"
	"gorm.io/gorm"
)

// Service 设备服务结构体
type Service struct {
	db *gorm.DB // 数据库连接
}

// NewService 创建新的设备服务实例
func NewService() *Service {
	return &Service{
		db: config.DB,
	}
}

// CreateDevice 创建设备
func (s *Service) CreateDevice(userID uint, name, platform string) (*models.Device, string, error) {
	// 创建新设备实例
	device := &models.Device{
		ID:       utils.GenerateDeviceID(), // 生成设备ID
		Name:     name,                     // 设备名称
		Platform: platform,                 // 设备平台
		OwnerID:  userID,                   // 设备所有者ID
		Status:   models.StatusOffline,     // 初始状态为离线
		LastSeen: time.Now(),               // 最后在线时间
	}

	// 保存设备到数据库
	if err := s.db.Create(device).Error; err != nil {
		return nil, "", err
	}

	// 生成安装命令
	installCommand := generateInstallCommand(device.ID)

	return device, installCommand, nil
}

// ListDevices 分页列出设备
func (s *Service) ListDevices(userID uint, isAdmin bool, page, limit int, filters map[string]interface{}) ([]*models.Device, int64, error) {
	var devices []*models.Device
	var total int64

	query := s.db.Model(&models.Device{})

	// 非管理员只能查看自己的设备
	if !isAdmin {
		query = query.Where("owner_id = ?", userID)
	}

	// 应用状态过滤器
	if status, ok := filters["status"].(string); ok && status != "" {
		query = query.Where("status = ?", status)
	}

	// 应用分组过滤器
	if groupID, ok := filters["group"].(string); ok && groupID != "" {
		query = query.Where("group_id = ?", groupID)
	}

	// 应用所有者过滤器（仅管理员可用）
	if ownerID, ok := filters["owner"].(uint); ok && ownerID > 0 && isAdmin {
		query = query.Where("owner_id = ?", ownerID)
	}

	// 获取总数量
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	// 分页查询设备列表
	offset := (page - 1) * limit
	if err := query.Offset(offset).Limit(limit).Preload("Owner").Find(&devices).Error; err != nil {
		return nil, 0, err
	}

	// 计算每个设备的当前状态
	for _, device := range devices {
		device.Status = s.calculateDeviceStatus(device.LastSeen)
	}

	return devices, total, nil
}

// GetDevice 获取单个设备详情
func (s *Service) GetDevice(deviceID string, userID uint, isAdmin bool) (*models.Device, error) {
	var device models.Device

	query := s.db.Preload("Owner").Preload("Group")

	// 非管理员只能查看自己的设备
	if !isAdmin {
		query = query.Where("owner_id = ?", userID)
	}

	// 根据设备ID查询设备
	if err := query.First(&device, "id = ?", deviceID).Error; err != nil {
		return nil, err
	}

	// 计算设备当前状态
	device.Status = s.calculateDeviceStatus(device.LastSeen)

	// 获取设备指标信息
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
