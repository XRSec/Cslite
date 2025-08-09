package agent

import (
	"encoding/json"
	"time"

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

type HeartbeatMetrics struct {
	CPUUsage   float64 `json:"cpu_usage"`
	MemoryUsed int     `json:"memory_used"`
	DiskUsage  float64 `json:"disk_usage"`
	NetworkIn  int     `json:"network_in"`
	NetworkOut int     `json:"network_out"`
}

func (s *Service) RegisterAgent(apiKey, name, platform, version string) (*models.Agent, *models.Device, error) {
	var apiKeyModel models.APIKey
	if err := s.db.Where("key = ?", apiKey).First(&apiKeyModel).Error; err != nil {
		return nil, nil, ErrInvalidAPIKey
	}

	if !config.AppConfig.AllowRegister {
		return nil, nil, ErrRegistrationDisabled
	}

	device := &models.Device{
		ID:       utils.GenerateDeviceID(),
		Name:     name,
		Platform: platform,
		OwnerID:  apiKeyModel.UserID,
		Status:   models.StatusOnline,
		LastSeen: time.Now(),
	}

	agent := &models.Agent{
		ID:            utils.GenerateAgentID(),
		DeviceID:      device.ID,
		Version:       version,
		LastHeartbeat: time.Now(),
	}

	if err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(device).Error; err != nil {
			return err
		}
		if err := tx.Create(agent).Error; err != nil {
			return err
		}
		return nil
	}); err != nil {
		return nil, nil, err
	}

	return agent, device, nil
}

func (s *Service) Heartbeat(agentID string, metrics *HeartbeatMetrics) error {
	var agent models.Agent
	if err := s.db.Where("id = ?", agentID).First(&agent).Error; err != nil {
		return ErrAgentNotFound
	}

	metricsJSON, _ := json.Marshal(metrics)

	if err := s.db.Model(&agent).Updates(map[string]interface{}{
		"last_heartbeat":    time.Now(),
		"heartbeat_metrics": string(metricsJSON),
	}).Error; err != nil {
		return err
	}

	if err := s.db.Model(&models.Device{}).Where("id = ?", agent.DeviceID).Updates(map[string]interface{}{
		"status":    models.StatusOnline,
		"last_seen": time.Now(),
	}).Error; err != nil {
		return err
	}

	return nil
}

func (s *Service) GetPendingCommands(agentID string) ([]*CommandTask, error) {
	var agent models.Agent
	if err := s.db.Where("id = ?", agentID).First(&agent).Error; err != nil {
		return nil, ErrAgentNotFound
	}

	var device models.Device
	if err := s.db.First(&device, "id = ?", agent.DeviceID).Error; err != nil {
		return nil, err
	}

	if device.Status == models.StatusOffline {
		return nil, ErrDeviceOffline
	}

	var commands []models.Command
	query := s.db.Where("status IN ?", []string{models.CommandStatusPending, models.CommandStatusRunning})

	query = query.Where("(target_type = 'devices' AND JSON_CONTAINS(target_ids, ?)) OR (target_type = 'groups' AND JSON_CONTAINS(target_ids, ?))",
		`"`+device.ID+`"`, `"`+device.GroupID+`"`)

	if err := query.Find(&commands).Error; err != nil {
		return nil, err
	}

	var tasks []*CommandTask
	for _, cmd := range commands {
		var execution models.Execution
		if err := s.db.Where("command_id = ? AND status = ?", cmd.ID, models.ExecutionStatusPending).First(&execution).Error; err != nil {
			execution = models.Execution{
				ID:        utils.GenerateExecutionID(),
				CommandID: cmd.ID,
				Status:    models.ExecutionStatusPending,
				StartedAt: time.Now(),
			}
			s.db.Create(&execution)
		}

		task := &CommandTask{
			CommandID:   cmd.ID,
			ExecutionID: execution.ID,
			Content:     cmd.Content,
			Timeout:     cmd.Timeout,
			EnvVars:     make(map[string]string),
		}

		if cmd.EnvVars != nil {
			json.Unmarshal(cmd.EnvVars, &task.EnvVars)
		}

		tasks = append(tasks, task)

		s.db.Model(&device).Update("status", models.StatusBusy)
	}

	return tasks, nil
}

func (s *Service) ReportResult(executionID, deviceID, status string, exitCode int, output, logContent string) error {
	var execution models.Execution
	if err := s.db.Where("id = ?", executionID).First(&execution).Error; err != nil {
		return ErrExecutionNotFound
	}

	var logPath string
	if logContent != "" {
		logPath = s.saveLogFile(executionID, deviceID, logContent)
	}

	result := &models.ExecutionResult{
		ID:          utils.GenerateExecutionID(),
		ExecutionID: executionID,
		DeviceID:    deviceID,
		Status:      status,
		ExitCode:    exitCode,
		Output:      output,
		LogPath:     logPath,
		StartedAt:   execution.StartedAt,
		CompletedAt: func() *time.Time { t := time.Now(); return &t }(),
	}

	if err := s.db.Create(result).Error; err != nil {
		return err
	}

	s.db.Model(&models.Device{}).Where("id = ?", deviceID).Update("status", models.StatusOnline)

	var allResults []models.ExecutionResult
	s.db.Where("execution_id = ?", executionID).Find(&allResults)

	allCompleted := true
	hasFailure := false
	for _, r := range allResults {
		if r.Status == models.ResultStatusPending {
			allCompleted = false
			break
		}
		if r.Status == models.ResultStatusFailed || r.Status == models.ResultStatusTimeout {
			hasFailure = true
		}
	}

	if allCompleted {
		executionStatus := models.ExecutionStatusCompleted
		if hasFailure {
			executionStatus = models.ExecutionStatusFailed
		}

		completedAt := time.Now()
		s.db.Model(&execution).Updates(map[string]interface{}{
			"status":       executionStatus,
			"completed_at": &completedAt,
		})

		s.db.Model(&models.Command{}).Where("id = ?", execution.CommandID).Update("status", executionStatus)
	}

	return nil
}

func (s *Service) saveLogFile(executionID, deviceID, content string) string {
	return "/var/cslite/files/logs/" + executionID + "_" + deviceID + ".log"
}

type CommandTask struct {
	CommandID   string            `json:"command_id"`
	ExecutionID string            `json:"execution_id"`
	Content     string            `json:"content"`
	Timeout     int               `json:"timeout"`
	EnvVars     map[string]string `json:"env_vars"`
}
