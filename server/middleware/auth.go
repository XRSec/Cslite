package middleware

import (
	"net/http"
	"strings"

	"github.com/cslite/cslite/server/internal/auth"
	"github.com/cslite/cslite/server/models"
	"github.com/cslite/cslite/server/utils"
	"github.com/gin-gonic/gin"
)

const (
	UserCtxKey = "user"
)

func AuthRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		user, err := authenticateRequest(c)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{
				"code":    40003,
				"message": "登录状态失效或Token过期",
				"data":    nil,
			})
			c.Abort()
			return
		}

		c.Set(UserCtxKey, user)
		c.Next()
	}
}

func AdminRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		user, err := authenticateRequest(c)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{
				"code":    40003,
				"message": "登录状态失效或Token过期",
				"data":    nil,
			})
			c.Abort()
			return
		}

		if !user.IsAdmin() {
			c.JSON(http.StatusForbidden, gin.H{
				"code":    40002,
				"message": "权限不足",
				"data":    nil,
			})
			c.Abort()
			return
		}

		c.Set(UserCtxKey, user)
		c.Next()
	}
}

func authenticateRequest(c *gin.Context) (*models.User, error) {
	authService := auth.NewService()

	if sessionToken, err := c.Cookie("session"); err == nil && sessionToken != "" {
		return authService.ValidateSession(sessionToken)
	}

	if apiKey := c.GetHeader("X-API-Key"); apiKey != "" {
		return authService.ValidateAPIKey(apiKey)
	}

	if authHeader := c.GetHeader("Authorization"); authHeader != "" {
		parts := strings.Split(authHeader, " ")
		if len(parts) == 2 && parts[0] == "Bearer" {
			claims, err := utils.ValidateJWT(parts[1])
			if err == nil {
				return authService.GetUserByID(claims.UserID)
			}
		}
	}

	return nil, auth.ErrInvalidSession
}

func GetCurrentUser(c *gin.Context) *models.User {
	if user, exists := c.Get(UserCtxKey); exists {
		if u, ok := user.(*models.User); ok {
			return u
		}
	}
	return nil
}