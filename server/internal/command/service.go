package command

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

type CreateCommandInput struct {
	Name        string              `json:"name"`
	Type        string              `json:"type"`
	Schedule    string              `json:"schedule"`
	Content     string              `json:"content"`
	TargetType  string              `json:"target_type"`
	TargetIDs   []string            `json:"target_ids"`
	Timeout     int                 `json:"timeout"`
	RetryPolicy *models.RetryPolicy `json:"retry_policy"`
	EnvVars     map[string]string   `json:"env_vars"`
}

func (s *Service) CreateCommand(userID uint, input *CreateCommandInput) (*models.Command, error) {
	targetIDsJSON, _ := json.Marshal(input.TargetIDs)
	retryPolicyJSON, _ := json.Marshal(input.RetryPolicy)
	envVarsJSON, _ := json.Marshal(input.EnvVars)

	command := &models.Command{
		ID:          utils.GenerateCommandID(),
		Name:        input.Name,
		Type:        input.Type,
		Schedule:    input.Schedule,
		Content:     input.Content,
		TargetType:  input.TargetType,
		TargetIDs:   targetIDsJSON,
		Timeout:     input.Timeout,
		RetryPolicy: retryPolicyJSON,
		EnvVars:     envVarsJSON,
		Status:      models.CommandStatusPending,
		CreatedBy:   userID,
	}

	if command.Type == models.CommandTypeImmediate {
		command.Status = models.CommandStatusRunning
	}

	if err := s.db.Create(command).Error; err != nil {
		return nil, err
	}

	if command.Type == models.CommandTypeImmediate {
		go s.executeCommand(command)
	}

	return command, nil
}

func (s *Service) ListCommands(userID uint, isAdmin bool, page, limit int, filters map[string]interface{}) ([]*models.Command, int64, error) {
	var commands []*models.Command
	var total int64

	query := s.db.Model(&models.Command{})

	if !isAdmin {
		query = query.Where("created_by = ?", userID)
	}

	if status, ok := filters["status"].(string); ok && status != "" {
		query = query.Where("status = ?", status)
	}

	if cmdType, ok := filters["type"].(string); ok && cmdType != "" {
		query = query.Where("type = ?", cmdType)
	}

	if deviceID, ok := filters["device"].(string); ok && deviceID != "" {
		query = query.Where("JSON_CONTAINS(target_ids, ?)", `"`+deviceID+`"`)
	}

	if ownerID, ok := filters["owner"].(uint); ok && ownerID > 0 && isAdmin {
		query = query.Where("created_by = ?", ownerID)
	}

	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	offset := (page - 1) * limit
	if err := query.Offset(offset).Limit(limit).Preload("Creator").Find(&commands).Error; err != nil {
		return nil, 0, err
	}

	return commands, total, nil
}

func (s *Service) GetCommand(commandID string, userID uint, isAdmin bool) (*models.Command, error) {
	var command models.Command

	query := s.db.Preload("Creator").Preload("Executions")

	if !isAdmin {
		query = query.Where("created_by = ?", userID)
	}

	if err := query.First(&command, "id = ?", commandID).Error; err != nil {
		return nil, err
	}

	return &command, nil
}

func (s *Service) UpdateCommandStatus(commandID string, action string, userID uint, isAdmin bool) error {
	var command models.Command

	query := s.db
	if !isAdmin {
		query = query.Where("created_by = ?", userID)
	}

	if err := query.First(&command, "id = ?", commandID).Error; err != nil {
		return err
	}

	switch action {
	case "pause":
		if command.Status != models.CommandStatusRunning {
			return ErrInvalidCommandStatus
		}
		command.Status = models.CommandStatusPaused
	case "resume":
		if command.Status != models.CommandStatusPaused {
			return ErrInvalidCommandStatus
		}
		command.Status = models.CommandStatusRunning
	case "cancel":
		if command.Status == models.CommandStatusCompleted || command.Status == models.CommandStatusCancelled {
			return ErrInvalidCommandStatus
		}
		command.Status = models.CommandStatusCancelled
	default:
		return ErrInvalidAction
	}

	return s.db.Save(&command).Error
}

func (s *Service) GetCommandResults(commandID string, userID uint, isAdmin bool) ([]*ExecutionDetail, error) {
	var command models.Command

	query := s.db
	if !isAdmin {
		query = query.Where("created_by = ?", userID)
	}

	if err := query.First(&command, "id = ?", commandID).Error; err != nil {
		return nil, err
	}

	var executions []models.Execution
	if err := s.db.Where("command_id = ?", commandID).Preload("Results.Device").Find(&executions).Error; err != nil {
		return nil, err
	}

	details := make([]*ExecutionDetail, len(executions))
	for i, exec := range executions {
		deviceResults := make([]*DeviceResult, len(exec.Results))
		for j, result := range exec.Results {
			deviceResults[j] = &DeviceResult{
				DeviceID: result.DeviceID,
				Status:   result.Status,
				ExitCode: result.ExitCode,
				Output:   result.Output,
				LogURL:   "/logs/download/" + result.LogPath,
			}
		}

		details[i] = &ExecutionDetail{
			ID:            exec.ID,
			Status:        exec.Status,
			StartedAt:     exec.StartedAt,
			CompletedAt:   exec.CompletedAt,
			DeviceResults: deviceResults,
		}
	}

	return details, nil
}

func (s *Service) executeCommand(command *models.Command) {
	execution := &models.Execution{
		ID:        utils.GenerateExecutionID(),
		CommandID: command.ID,
		Status:    models.ExecutionStatusRunning,
		StartedAt: time.Now(),
	}

	s.db.Create(execution)

	s.db.Model(command).Update("status", models.CommandStatusRunning)
}

// calculateNextRun 计算下次执行时间（供客户端参考，服务端不负责调度）
// func calculateNextRun(schedule string) (time.Time, error) {
// 	parser := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
// 	sched, err := parser.Parse(schedule)
// 	if err != nil {
// 		return time.Time{}, err
// 	}
// 	return sched.Next(time.Now()), nil
// }

type ExecutionDetail struct {
	ID            string          `json:"id"`
	Status        string          `json:"status"`
	StartedAt     time.Time       `json:"started_at"`
	CompletedAt   *time.Time      `json:"completed_at,omitempty"`
	DeviceResults []*DeviceResult `json:"device_results"`
}

type DeviceResult struct {
	DeviceID string `json:"device_id"`
	Status   string `json:"status"`
	ExitCode int    `json:"exit_code"`
	Output   string `json:"output"`
	LogURL   string `json:"log_url"`
}
