// middleware 包定义了HTTP中间件
package middleware

import (
	"net/http"
	"strings"

	"github.com/XRSec/Cslite/internal/auth"
	"github.com/XRSec/Cslite/models"
	"github.com/XRSec/Cslite/utils"
	"github.com/XRSec/Cslite/config"
	"github.com/gin-gonic/gin"
)

// 上下文键常量
const (
	UserCtxKey = "user" // 用户上下文键
)

// AuthRequired 认证中间件，要求用户必须登录
func AuthRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		// 验证请求的认证信息
		user, err := authenticateRequest(c)
		if err != nil {
			// 认证失败，返回未授权错误
			c.JSON(http.StatusUnauthorized, gin.H{
				"code":    40003,
				"message": "登录状态失效或Token过期",
				"data":    nil,
			})
			c.Abort()
			return
		}

		// 将用户信息存储到上下文中
		c.Set(UserCtxKey, user)
		c.Next()
	}
}

// AdminRequired 管理员权限中间件，要求用户必须是管理员
func AdminRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		// 验证请求的认证信息
		user, err := authenticateRequest(c)
		if err != nil {
			// 认证失败，返回未授权错误
			c.JSON(http.StatusUnauthorized, gin.H{
				"code":    40003,
				"message": "登录状态失效或Token过期",
				"data":    nil,
			})
			c.Abort()
			return
		}

		// 检查用户是否为管理员
		if !user.IsAdmin() {
			// 权限不足，返回禁止访问错误
			c.JSON(http.StatusForbidden, gin.H{
				"code":    40002,
				"message": "权限不足",
				"data":    nil,
			})
			c.Abort()
			return
		}

		// 将用户信息存储到上下文中
		c.Set(UserCtxKey, user)
		c.Next()
	}
}

// authenticateRequest 验证请求的认证信息
func authenticateRequest(c *gin.Context) (*models.User, error) {
	authService := auth.NewService()

	// 尝试从Cookie中获取会话令牌
	if sessionToken, err := c.Cookie("session"); err == nil && sessionToken != "" {
		return authService.ValidateSession(sessionToken)
	}

	// 尝试从请求头中获取API密钥
	if apiKey := c.GetHeader("X-API-Key"); apiKey != "" {
		return authService.ValidateAPIKey(apiKey)
	}

	// 尝试从Authorization头中获取JWT令牌
	if authHeader := c.GetHeader("Authorization"); authHeader != "" {
		parts := strings.Split(authHeader, " ")
		if len(parts) == 2 && parts[0] == "Bearer" {
			// 验证JWT令牌
			claims, err := utils.ValidateJWT(parts[1], config.AppConfig.JWTSecret)
			if err == nil {
				return authService.GetUserByID(claims.UserID)
			}
		}
	}

	// 所有认证方式都失败
	return nil, auth.ErrInvalidSession
}

// GetCurrentUser 从上下文中获取当前用户
func GetCurrentUser(c *gin.Context) *models.User {
	if user, exists := c.Get(UserCtxKey); exists {
		if u, ok := user.(*models.User); ok {
			return u
		}
	}
	return nil
}