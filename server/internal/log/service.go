package log

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/cslite/cslite/server/config"
	"github.com/cslite/cslite/server/models"
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

type CommandLog struct {
	ExecutionID   string `json:"execution_id"`
	DeviceID      string `json:"device_id"`
	Status        string `json:"status"`
	ExitCode      int    `json:"exit_code"`
	OutputPreview string `json:"output_preview"`
	LogURL        string `json:"log_url"`
	StartedAt     string `json:"started_at"`
	CompletedAt   string `json:"completed_at,omitempty"`
}

type DeviceLog struct {
	ID        string `json:"id"`
	DeviceID  string `json:"device_id"`
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Message   string `json:"message"`
}

type UserLog struct {
	ID        string `json:"id"`
	UserID    uint   `json:"user_id"`
	Action    string `json:"action"`
	TargetID  string `json:"target_id"`
	IP        string `json:"ip"`
	Timestamp string `json:"timestamp"`
}

func (s *Service) GetCommandLogs(commandID string, deviceID string, status string, page, limit int) ([]*CommandLog, int64, error) {
	var results []models.ExecutionResult
	var total int64

	query := s.db.Model(&models.ExecutionResult{}).
		Joins("JOIN executions ON execution_results.execution_id = executions.id").
		Where("executions.command_id = ?", commandID)

	if deviceID != "" {
		query = query.Where("execution_results.device_id = ?", deviceID)
	}

	if status != "" {
		query = query.Where("execution_results.status = ?", status)
	}

	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	offset := (page - 1) * limit
	if err := query.Offset(offset).Limit(limit).Find(&results).Error; err != nil {
		return nil, 0, err
	}

	logs := make([]*CommandLog, len(results))
	for i, result := range results {
		outputPreview := result.Output
		if len(outputPreview) > 200 {
			outputPreview = outputPreview[:200] + "..."
		}

		log := &CommandLog{
			ExecutionID:   result.ExecutionID,
			DeviceID:      result.DeviceID,
			Status:        result.Status,
			ExitCode:      result.ExitCode,
			OutputPreview: outputPreview,
			LogURL:        fmt.Sprintf("/logs/download/%s_%s.log", result.ExecutionID, result.DeviceID),
			StartedAt:     result.StartedAt.Format("2006-01-02T15:04:05Z"),
		}

		if result.CompletedAt != nil {
			log.CompletedAt = result.CompletedAt.Format("2006-01-02T15:04:05Z")
		}

		logs[i] = log
	}

	return logs, total, nil
}

func (s *Service) GetDeviceLogs(deviceID string, logType string, page, limit int) ([]*DeviceLog, int64, error) {
	logs := []*DeviceLog{
		{
			ID:        "log_dev_001",
			DeviceID:  deviceID,
			Type:      "heartbeat",
			Timestamp: "2025-06-20T03:00:00Z",
			Message:   "CPU: 12%, Memory: 1523MB",
		},
		{
			ID:        "log_dev_002",
			DeviceID:  deviceID,
			Type:      "register",
			Timestamp: "2025-06-20T02:00:00Z",
			Message:   "Device registered successfully",
		},
	}

	return logs, 2, nil
}

func (s *Service) GetUserLogs(userID uint, action string, page, limit int) ([]*UserLog, int64, error) {
	logs := []*UserLog{
		{
			ID:        "log_user_001",
			UserID:    userID,
			Action:    "创建命令",
			TargetID:  "cmd_abc123",
			IP:        "192.168.1.10",
			Timestamp: "2025-06-20T10:00:00Z",
		},
		{
			ID:        "log_user_002",
			UserID:    userID,
			Action:    "删除设备",
			TargetID:  "dev_xyz456",
			IP:        "192.168.1.10",
			Timestamp: "2025-06-20T09:30:00Z",
		},
	}

	return logs, 2, nil
}

func (s *Service) DownloadLog(logID string) (io.ReadCloser, error) {
	logPath := filepath.Join(config.AppConfig.FileDir, "logs", logID)
	
	file, err := os.Open(logPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrLogNotFound
		}
		return nil, err
	}

	return file, nil
}