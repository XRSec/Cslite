package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/XRSec/Cslite/internal/device"
	"github.com/XRSec/Cslite/middleware"
	"github.com/gin-gonic/gin"
)

type DeviceHandler struct {
	service *device.Service
}

func NewDeviceHandler() *DeviceHandler {
	return &DeviceHandler{
		service: device.NewService(),
	}
}

type CreateDeviceRequest struct {
	Name     string `json:"name" binding:"required,min=1,max=100"`
	Platform string `json:"platform" binding:"required"`
}

type DeleteDevicesRequest struct {
	IDs []string `json:"ids" binding:"required,min=1"`
}

func (h *DeviceHandler) CreateDevice(c *gin.Context) {
	var req CreateDeviceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    40004,
			"message": "参数缺失或格式错误",
			"data":    nil,
		})
		return
	}

	user := middleware.GetCurrentUser(c)

	device, installCmd, err := h.service.CreateDevice(user.ID, req.Name, req.Platform)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    50001,
			"message": "系统异常",
			"data":    nil,
		})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"code":    20000,
		"message": "设备创建成功",
		"data": gin.H{
			"id":              device.ID,
			"install_command": installCmd,
			"expires_at":      time.Now().Add(7 * 24 * time.Hour).Format(time.RFC3339),
		},
	})
}

func (h *DeviceHandler) ListDevices(c *gin.Context) {
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
	if group := c.Query("group"); group != "" {
		filters["group"] = group
	}
	if ownerStr := c.Query("owner"); ownerStr != "" {
		if owner, err := strconv.ParseUint(ownerStr, 10, 32); err == nil {
			filters["owner"] = uint(owner)
		}
	}

	devices, total, err := h.service.ListDevices(user.ID, user.IsAdmin(), page, limit, filters)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    50001,
			"message": "系统异常",
			"data":    nil,
		})
		return
	}

	deviceList := make([]gin.H, len(devices))
	for i, device := range devices {
		deviceList[i] = gin.H{
			"id":         device.ID,
			"name":       device.Name,
			"platform":   device.Platform,
			"status":     device.Status,
			"owner_id":   device.OwnerID,
			"group_id":   device.GroupID,
			"last_seen":  device.LastSeen.Format(time.RFC3339),
			"ip_address": device.IPAddress,
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    20000,
		"message": "获取成功",
		"data": gin.H{
			"total":    total,
			"page":     page,
			"per_page": limit,
			"devices":  deviceList,
		},
	})
}

func (h *DeviceHandler) GetDevice(c *gin.Context) {
	deviceID := c.Param("id")
	user := middleware.GetCurrentUser(c)

	device, err := h.service.GetDevice(deviceID, user.ID, user.IsAdmin())
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{
			"code":    40005,
			"message": "设备不存在",
			"data":    nil,
		})
		return
	}

	metrics := gin.H{
		"cpu_usage":   15.3,
		"memory_used": 2048,
		"disk_usage":  45.2,
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    20000,
		"message": "获取成功",
		"data": gin.H{
			"id":         device.ID,
			"name":       device.Name,
			"platform":   device.Platform,
			"status":     device.Status,
			"metrics":    metrics,
			"owner_id":   device.OwnerID,
			"group_id":   device.GroupID,
			"created_at": device.CreatedAt.Format(time.RFC3339),
			"last_seen":  device.LastSeen.Format(time.RFC3339),
		},
	})
}

func (h *DeviceHandler) DeleteDevices(c *gin.Context) {
	var req DeleteDevicesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    40004,
			"message": "参数缺失或格式错误",
			"data":    nil,
		})
		return
	}

	user := middleware.GetCurrentUser(c)

	deletedCount, err := h.service.DeleteDevices(req.IDs, user.ID, user.IsAdmin())
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
		"message": "删除成功",
		"data": gin.H{
			"deleted_count": deletedCount,
		},
	})
}

func (h *DeviceHandler) GetDeviceStatus(c *gin.Context) {
	deviceID := c.Query("id")
	if deviceID == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    40004,
			"message": "参数缺失",
			"data":    nil,
		})
		return
	}

	status, err := h.service.GetDeviceStatus(deviceID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{
			"code":    40005,
			"message": "设备不存在",
			"data":    nil,
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    20000,
		"message": "获取成功",
		"data":    status,
	})
}
