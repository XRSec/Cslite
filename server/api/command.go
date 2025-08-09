package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/XRSec/Cslite/internal/command"
	"github.com/XRSec/Cslite/middleware"
	"github.com/XRSec/Cslite/models"
	"github.com/gin-gonic/gin"
)

type CommandHandler struct {
	service *command.Service
}

func NewCommandHandler() *CommandHandler {
	return &CommandHandler{
		service: command.NewService(),
	}
}

type CreateCommandRequest struct {
	Name        string              `json:"name" binding:"required,min=1,max=100"`
	Type        string              `json:"type" binding:"required,oneof=once cron immediate"`
	Schedule    string              `json:"schedule"`
	Content     string              `json:"content" binding:"required"`
	TargetType  string              `json:"target_type" binding:"required,oneof=devices groups"`
	TargetIDs   []string            `json:"target_ids" binding:"required,min=1"`
	Timeout     int                 `json:"timeout" binding:"min=1,max=86400"`
	RetryPolicy *models.RetryPolicy `json:"retry_policy"`
	EnvVars     map[string]string   `json:"env_vars"`
}

type UpdateCommandStatusRequest struct {
	Action string `json:"action" binding:"required,oneof=pause resume cancel"`
}

func (h *CommandHandler) CreateCommand(c *gin.Context) {
	var req CreateCommandRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    40004,
			"message": "参数缺失或格式错误",
			"data":    nil,
		})
		return
	}

	// 验证cron类型必须有schedule
	if req.Type == models.CommandTypeCron && req.Schedule == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    60002,
			"message": "cron 表达式非法或不合理",
			"data":    nil,
		})
		return
	}

	user := middleware.GetCurrentUser(c)

	input := &command.CreateCommandInput{
		Name:        req.Name,
		Type:        req.Type,
		Schedule:    req.Schedule,
		Content:     req.Content,
		TargetType:  req.TargetType,
		TargetIDs:   req.TargetIDs,
		Timeout:     req.Timeout,
		RetryPolicy: req.RetryPolicy,
		EnvVars:     req.EnvVars,
	}

	if input.Timeout == 0 {
		input.Timeout = 1800
	}

	cmd, err := h.service.CreateCommand(user.ID, input)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    50001,
			"message": "系统异常",
			"data":    nil,
		})
		return
	}

	response := gin.H{
		"id":         cmd.ID,
		"created_at": cmd.CreatedAt.Format(time.RFC3339),
	}

	// 如果是cron类型，返回下次执行时间（供客户端参考）
	// if cmd.NextRun != nil {
	// 	response["next_run"] = cmd.NextRun.Format(time.RFC3339)
	// }

	c.JSON(http.StatusCreated, gin.H{
		"code":    20000,
		"message": "命令创建成功",
		"data":    response,
	})
}

func (h *CommandHandler) ListCommands(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))

	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 20
	}

	user := middleware.GetCurrentUser(c)

	filters := make(map[string]interface{})
	if status := c.Query("status"); status != "" {
		filters["status"] = status
	}
	if cmdType := c.Query("type"); cmdType != "" {
		filters["type"] = cmdType
	}
	if device := c.Query("device"); device != "" {
		filters["device"] = device
	}
	if ownerStr := c.Query("owner"); ownerStr != "" {
		if owner, err := strconv.ParseUint(ownerStr, 10, 32); err == nil {
			filters["owner"] = uint(owner)
		}
	}

	commands, total, err := h.service.ListCommands(user.ID, user.IsAdmin(), page, limit, filters)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    50001,
			"message": "系统异常",
			"data":    nil,
		})
		return
	}

	commandList := make([]gin.H, len(commands))
	for i, cmd := range commands {
		item := gin.H{
			"id":         cmd.ID,
			"name":       cmd.Name,
			"type":       cmd.Type,
			"status":     cmd.Status,
			"created_at": cmd.CreatedAt.Format(time.RFC3339),
		}
		// 如果是cron类型，返回下次执行时间（供客户端参考）
		// if cmd.NextRun != nil {
		// 	item["next_run"] = cmd.NextRun.Format(time.RFC3339)
		// }
		commandList[i] = item
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    20000,
		"message": "获取成功",
		"data": gin.H{
			"total":    total,
			"commands": commandList,
		},
	})
}

func (h *CommandHandler) GetCommand(c *gin.Context) {
	commandID := c.Param("id")
	user := middleware.GetCurrentUser(c)

	cmd, err := h.service.GetCommand(commandID, user.ID, user.IsAdmin())
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{
			"code":    40005,
			"message": "命令不存在",
			"data":    nil,
		})
		return
	}

	executionHistory := make([]gin.H, len(cmd.Executions))
	for i, exec := range cmd.Executions {
		item := gin.H{
			"id":         exec.ID,
			"status":     exec.Status,
			"started_at": exec.StartedAt.Format(time.RFC3339),
		}
		if exec.CompletedAt != nil {
			item["completed_at"] = exec.CompletedAt.Format(time.RFC3339)
		}
		executionHistory[i] = item
	}

	response := gin.H{
		"id":                cmd.ID,
		"name":              cmd.Name,
		"type":              cmd.Type,
		"schedule":          cmd.Schedule,
		"content":           cmd.Content,
		"status":            cmd.Status,
		"target_type":       cmd.TargetType,
		"target_ids":        cmd.TargetIDs,
		"env_vars":          cmd.EnvVars,
		"created_at":        cmd.CreatedAt.Format(time.RFC3339),
		"execution_history": executionHistory,
	}

	// 如果是cron类型，返回下次执行时间（供客户端参考）
	// if cmd.NextRun != nil {
	// 	response["next_run"] = cmd.NextRun.Format(time.RFC3339)
	// }

	c.JSON(http.StatusOK, gin.H{
		"code":    20000,
		"message": "获取成功",
		"data":    response,
	})
}

func (h *CommandHandler) UpdateCommandStatus(c *gin.Context) {
	commandID := c.Param("id")

	var req UpdateCommandStatusRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    40004,
			"message": "参数缺失或格式错误",
			"data":    nil,
		})
		return
	}

	user := middleware.GetCurrentUser(c)

	if err := h.service.UpdateCommandStatus(commandID, req.Action, user.ID, user.IsAdmin()); err != nil {
		if err == command.ErrInvalidCommandStatus {
			c.JSON(http.StatusConflict, gin.H{
				"code":    40006,
				"message": "当前状态不允许该操作",
				"data":    nil,
			})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    50001,
			"message": "系统异常",
			"data":    nil,
		})
		return
	}

	actionMessage := map[string]string{
		"pause":  "命令已暂停",
		"resume": "命令已恢复",
		"cancel": "命令已取消",
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    20000,
		"message": actionMessage[req.Action],
		"data": gin.H{
			"updated_at": time.Now().Format(time.RFC3339),
		},
	})
}

func (h *CommandHandler) GetCommandResults(c *gin.Context) {
	commandID := c.Param("id")
	user := middleware.GetCurrentUser(c)

	results, err := h.service.GetCommandResults(commandID, user.ID, user.IsAdmin())
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{
			"code":    40005,
			"message": "命令不存在",
			"data":    nil,
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    20000,
		"message": "获取成功",
		"data": gin.H{
			"command_id": commandID,
			"executions": results,
		},
	})
}
