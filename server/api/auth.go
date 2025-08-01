package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/cslite/cslite/server/internal/auth"
	"github.com/cslite/cslite/server/middleware"
	"github.com/cslite/cslite/server/models"
	"github.com/gin-gonic/gin"
)

type AuthHandler struct {
	service *auth.Service
}

func NewAuthHandler() *AuthHandler {
	return &AuthHandler{
		service: auth.NewService(),
	}
}

type LoginRequest struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
}

type CreateUserRequest struct {
	Username string `json:"username" binding:"required,min=3,max=50"`
	Password string `json:"password" binding:"required,min=8,max=128"`
	Email    string `json:"email" binding:"omitempty,email"`
	Role     int    `json:"role" binding:"omitempty,oneof=0 1"`
}

func (h *AuthHandler) Login(c *gin.Context) {
	var req LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    40004,
			"message": "参数缺失或格式错误",
			"data":    nil,
		})
		return
	}

	user, token, err := h.service.Login(req.Username, req.Password)
	if err != nil {
		if err == auth.ErrInvalidCredentials {
			c.JSON(http.StatusUnauthorized, gin.H{
				"code":    40001,
				"message": "用户名或密码错误",
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

	c.SetCookie(
		"session",
		token,
		7*24*60*60,
		"/",
		"",
		true,
		true,
	)

	c.JSON(http.StatusOK, gin.H{
		"code":    20000,
		"message": "登录成功",
		"data": gin.H{
			"user": gin.H{
				"id":       user.ID,
				"username": user.Username,
				"email":    user.Email,
				"role":     user.Role,
			},
			"session_token": token,
		},
	})
}

func (h *AuthHandler) Logout(c *gin.Context) {
	sessionToken, _ := c.Cookie("session")
	if sessionToken != "" {
		h.service.Logout(sessionToken)
	}

	c.SetCookie(
		"session",
		"",
		-1,
		"/",
		"",
		true,
		true,
	)

	c.JSON(http.StatusOK, gin.H{
		"code":    20000,
		"message": "已注销",
		"data":    nil,
	})
}

func (h *AuthHandler) GenerateAPIKey(c *gin.Context) {
	user := middleware.GetCurrentUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{
			"code":    40003,
			"message": "登录状态已过期",
			"data":    nil,
		})
		return
	}

	apiKey, err := h.service.GenerateAPIKey(user.ID)
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
		"message": "API Key 生成成功",
		"data": gin.H{
			"api_key":    apiKey,
			"created_at": time.Now().Format(time.RFC3339),
		},
	})
}

func (h *AuthHandler) CreateUser(c *gin.Context) {
	var req CreateUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    40004,
			"message": "参数缺失或格式错误",
			"data":    nil,
		})
		return
	}

	user, err := h.service.CreateUser(req.Username, req.Password, req.Email, req.Role)
	if err != nil {
		if err == auth.ErrUserExists {
			c.JSON(http.StatusConflict, gin.H{
				"code":    40009,
				"message": "用户名已存在",
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

	c.JSON(http.StatusCreated, gin.H{
		"code":    20000,
		"message": "用户创建成功",
		"data": gin.H{
			"id":         user.ID,
			"username":   user.Username,
			"email":      user.Email,
			"role":       user.Role,
			"created_at": user.CreatedAt.Format(time.RFC3339),
		},
	})
}

func (h *AuthHandler) ListUsers(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))

	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 20
	}

	users, total, err := h.service.ListUsers(page, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    50001,
			"message": "系统异常",
			"data":    nil,
		})
		return
	}

	userList := make([]gin.H, len(users))
	for i, user := range users {
		userList[i] = gin.H{
			"id":         user.ID,
			"username":   user.Username,
			"email":      user.Email,
			"role":       user.Role,
			"created_at": user.CreatedAt.Format(time.RFC3339),
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    20000,
		"message": "获取成功",
		"data": gin.H{
			"total":    total,
			"page":     page,
			"per_page": limit,
			"users":    userList,
		},
	})
}

func (h *AuthHandler) DeleteUser(c *gin.Context) {
	userID, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    40004,
			"message": "参数格式错误",
			"data":    nil,
		})
		return
	}

	currentUser := middleware.GetCurrentUser(c)
	if currentUser.ID == uint(userID) {
		c.JSON(http.StatusConflict, gin.H{
			"code":    40006,
			"message": "无法删除自己",
			"data":    nil,
		})
		return
	}

	if err := h.service.DeleteUser(uint(userID)); err != nil {
		c.JSON(http.StatusNotFound, gin.H{
			"code":    40005,
			"message": "用户不存在",
			"data":    nil,
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    20000,
		"message": "用户删除成功",
		"data": gin.H{
			"deleted_at": time.Now().Format(time.RFC3339),
		},
	})
}