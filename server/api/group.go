package api

import (
	"net/http"
	"time"

	"github.com/XRSec/Cslite/internal/group"
	"github.com/XRSec/Cslite/middleware"
	"github.com/gin-gonic/gin"
)

type GroupHandler struct {
	service *group.Service
}

func NewGroupHandler() *GroupHandler {
	return &GroupHandler{
		service: group.NewService(),
	}
}

type CreateGroupRequest struct {
	Name        string `json:"name" binding:"required,min=1,max=100"`
	Description string `json:"description" binding:"max=500"`
}

type AddDevicesRequest struct {
	DeviceIDs []string `json:"device_ids" binding:"required,min=1"`
}

func (h *GroupHandler) CreateGroup(c *gin.Context) {
	var req CreateGroupRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    40004,
			"message": "参数缺失或格式错误",
			"data":    nil,
		})
		return
	}

	user := middleware.GetCurrentUser(c)

	group, err := h.service.CreateGroup(user.ID, req.Name, req.Description)
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
		"message": "群组创建成功",
		"data": gin.H{
			"id":         group.ID,
			"created_at": group.CreatedAt.Format(time.RFC3339),
		},
	})
}

func (h *GroupHandler) ListGroups(c *gin.Context) {
	user := middleware.GetCurrentUser(c)

	groups, err := h.service.ListGroups(user.ID, user.IsAdmin())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    50001,
			"message": "系统异常",
			"data":    nil,
		})
		return
	}

	groupList := make([]gin.H, len(groups))
	for i, group := range groups {
		groupList[i] = gin.H{
			"id":           group.ID,
			"name":         group.Name,
			"description":  group.Description,
			"device_count": len(group.Devices),
			"created_at":   group.CreatedAt.Format(time.RFC3339),
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    20000,
		"message": "获取成功",
		"data":    groupList,
	})
}

func (h *GroupHandler) AddDevicesToGroup(c *gin.Context) {
	groupID := c.Param("id")

	var req AddDevicesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    40004,
			"message": "参数缺失或格式错误",
			"data":    nil,
		})
		return
	}

	user := middleware.GetCurrentUser(c)

	addedCount, err := h.service.AddDevicesToGroup(groupID, req.DeviceIDs, user.ID, user.IsAdmin())
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{
			"code":    40005,
			"message": "群组不存在",
			"data":    nil,
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    20000,
		"message": "添加成功",
		"data": gin.H{
			"added_count": addedCount,
		},
	})
}

func (h *GroupHandler) DeleteGroup(c *gin.Context) {
	groupID := c.Param("id")
	user := middleware.GetCurrentUser(c)

	reassignedDevices, err := h.service.DeleteGroup(groupID, user.ID, user.IsAdmin())
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{
			"code":    40005,
			"message": "群组不存在",
			"data":    nil,
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    20000,
		"message": "删除成功",
		"data": gin.H{
			"deleted_at":         time.Now().Format(time.RFC3339),
			"reassigned_devices": reassignedDevices,
		},
	})
}
