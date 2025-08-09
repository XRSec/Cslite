package api

import (
	"encoding/base64"
	"net/http"
	"time"

	"github.com/XRSec/Cslite/config"
	"github.com/XRSec/Cslite/internal/agent"
	"github.com/gin-gonic/gin"
)

type AgentHandler struct {
	service *agent.Service
}

func NewAgentHandler() *AgentHandler {
	return &AgentHandler{
		service: agent.NewService(),
	}
}

type RegisterRequest struct {
	Name     string `json:"name" binding:"required,min=1,max=100"`
	Platform string `json:"platform" binding:"required"`
	Version  string `json:"version" binding:"required"`
}

type HeartbeatRequest struct {
	AgentID   string                  `json:"agent_id" binding:"required"`
	Metrics   *agent.HeartbeatMetrics `json:"metrics"`
	Timestamp string                  `json:"timestamp"`
}

type ReportResultRequest struct {
	ExecutionID string `json:"execution_id" binding:"required"`
	DeviceID    string `json:"device_id" binding:"required"`
	Status      string `json:"status" binding:"required,oneof=completed failed timeout cancelled"`
	ExitCode    int    `json:"exit_code"`
	Output      string `json:"output"`
	Log         string `json:"log"`
	CompletedAt string `json:"completed_at"`
}

func (h *AgentHandler) Register(c *gin.Context) {
	apiKey := c.GetHeader("X-API-Key")
	if apiKey == "" {
		c.JSON(http.StatusUnauthorized, gin.H{
			"code":    40003,
			"message": "Missing API key",
			"data":    nil,
		})
		return
	}

	var req RegisterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    40004,
			"message": "参数缺失或格式错误",
			"data":    nil,
		})
		return
	}

	agentModel, device, err := h.service.RegisterAgent(apiKey, req.Name, req.Platform, req.Version)
	if err != nil {
		if err == agent.ErrInvalidAPIKey {
			c.JSON(http.StatusUnauthorized, gin.H{
				"code":    40003,
				"message": "Invalid API key",
				"data":    nil,
			})
			return
		}
		if err == agent.ErrRegistrationDisabled {
			c.JSON(http.StatusForbidden, gin.H{
				"code":    40013,
				"message": "Agent registration is disabled",
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

	c.JSON(http.StatusOK, gin.H{
		"code":    20000,
		"message": "注册成功",
		"data": gin.H{
			"agent_id":           agentModel.ID,
			"device_id":          device.ID,
			"heartbeat_interval": config.AppConfig.HeartbeatInterval,
		},
	})
}

func (h *AgentHandler) Heartbeat(c *gin.Context) {
	apiKey := c.GetHeader("X-API-Key")
	if apiKey == "" {
		c.JSON(http.StatusUnauthorized, gin.H{
			"code":    40003,
			"message": "Missing API key",
			"data":    nil,
		})
		return
	}

	var req HeartbeatRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    40004,
			"message": "参数缺失或格式错误",
			"data":    nil,
		})
		return
	}

	if err := h.service.Heartbeat(req.AgentID, req.Metrics); err != nil {
		if err == agent.ErrAgentNotFound {
			c.JSON(http.StatusNotFound, gin.H{
				"code":    40010,
				"message": "设备不存在",
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

	c.JSON(http.StatusOK, gin.H{
		"code":    20000,
		"message": "心跳成功",
		"data": gin.H{
			"status":         "ok",
			"next_heartbeat": time.Now().Add(time.Duration(config.AppConfig.HeartbeatInterval) * time.Second).Format(time.RFC3339),
		},
	})
}

func (h *AgentHandler) PollCommands(c *gin.Context) {
	apiKey := c.GetHeader("X-API-Key")
	if apiKey == "" {
		c.JSON(http.StatusUnauthorized, gin.H{
			"code":    40003,
			"message": "Missing API key",
			"data":    nil,
		})
		return
	}

	agentID := c.Query("agent_id")
	if agentID == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    40004,
			"message": "参数缺失",
			"data":    nil,
		})
		return
	}

	commands, err := h.service.GetPendingCommands(agentID)
	if err != nil {
		if err == agent.ErrAgentNotFound {
			c.JSON(http.StatusNotFound, gin.H{
				"code":    40010,
				"message": "设备不存在",
				"data":    nil,
			})
			return
		}
		if err == agent.ErrDeviceOffline {
			c.JSON(http.StatusConflict, gin.H{
				"code":    40011,
				"message": "设备离线",
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

	c.JSON(http.StatusOK, gin.H{
		"code":    20000,
		"message": "获取成功",
		"data": gin.H{
			"commands": commands,
		},
	})
}

func (h *AgentHandler) ReportResult(c *gin.Context) {
	apiKey := c.GetHeader("X-API-Key")
	if apiKey == "" {
		c.JSON(http.StatusUnauthorized, gin.H{
			"code":    40003,
			"message": "Missing API key",
			"data":    nil,
		})
		return
	}

	var req ReportResultRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    40004,
			"message": "参数缺失或格式错误",
			"data":    nil,
		})
		return
	}

	var logContent string
	if req.Log != "" {
		decoded, err := base64.StdEncoding.DecodeString(req.Log)
		if err == nil {
			logContent = string(decoded)
		}
	}

	if err := h.service.ReportResult(req.ExecutionID, req.DeviceID, req.Status, req.ExitCode, req.Output, logContent); err != nil {
		if err == agent.ErrExecutionNotFound {
			c.JSON(http.StatusNotFound, gin.H{
				"code":    40020,
				"message": "命令不存在",
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

	c.JSON(http.StatusOK, gin.H{
		"code":    20000,
		"message": "结果上报成功",
		"data": gin.H{
			"status": "received",
			"logged": true,
		},
	})
}
