package api

import (
	"io"
	"net/http"
	"strconv"

	"github.com/cslite/cslite/server/internal/log"
	"github.com/cslite/cslite/server/middleware"
	"github.com/gin-gonic/gin"
)

type LogHandler struct {
	service *log.Service
}

func NewLogHandler() *LogHandler {
	return &LogHandler{
		service: log.NewService(),
	}
}

func (h *LogHandler) GetCommandLogs(c *gin.Context) {
	commandID := c.Query("command_id")
	if commandID == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    40004,
			"message": "参数缺失：command_id",
			"data":    nil,
		})
		return
	}

	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))
	
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 20
	}

	deviceID := c.Query("device_id")
	status := c.Query("status")

	logs, total, err := h.service.GetCommandLogs(commandID, deviceID, status, page, limit)
	if err != nil {
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
			"total": total,
			"logs":  logs,
		},
	})
}

func (h *LogHandler) GetDeviceLogs(c *gin.Context) {
	deviceID := c.Query("device_id")
	if deviceID == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    40004,
			"message": "参数缺失：device_id",
			"data":    nil,
		})
		return
	}

	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))
	
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 20
	}

	logType := c.Query("type")

	logs, total, err := h.service.GetDeviceLogs(deviceID, logType, page, limit)
	if err != nil {
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
			"total": total,
			"logs":  logs,
		},
	})
}

func (h *LogHandler) GetUserLogs(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))
	
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 20
	}

	userIDStr := c.Query("user_id")
	var userID uint
	if userIDStr != "" {
		if id, err := strconv.ParseUint(userIDStr, 10, 32); err == nil {
			userID = uint(id)
		}
	}

	action := c.Query("action")

	logs, total, err := h.service.GetUserLogs(userID, action, page, limit)
	if err != nil {
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
			"total": total,
			"logs":  logs,
		},
	})
}

func (h *LogHandler) DownloadLog(c *gin.Context) {
	logID := c.Param("log_id")
	
	user := middleware.GetCurrentUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{
			"code":    40003,
			"message": "登录状态已过期",
			"data":    nil,
		})
		return
	}

	file, err := h.service.DownloadLog(logID)
	if err != nil {
		if err == log.ErrLogNotFound {
			c.JSON(http.StatusNotFound, gin.H{
				"code":    40005,
				"message": "日志不存在或权限不足",
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
	defer file.Close()

	c.Header("Content-Type", "text/plain")
	c.Header("Content-Disposition", "attachment; filename="+logID)
	
	if _, err := io.Copy(c.Writer, file); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    50001,
			"message": "系统异常",
			"data":    nil,
		})
	}
}