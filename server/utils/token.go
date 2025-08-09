// utils 包提供了通用的工具函数
package utils

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Claims JWT声明结构体，包含用户信息
type Claims struct {
	UserID   uint   `json:"user_id"`   // 用户ID
	Username string `json:"username"`   // 用户名
	Role     int    `json:"role"`      // 用户角色
	jwt.RegisteredClaims               // JWT标准声明
}

// GenerateJWT 生成JWT令牌
func GenerateJWT(userID uint, username string, role int, secret string) (string, error) {
	claims := &Claims{
		UserID:   userID,
		Username: username,
		Role:     role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(7 * 24 * time.Hour)), // 7天后过期
			IssuedAt:  jwt.NewNumericDate(time.Now()),                         // 签发时间
		},
	}

	// 使用HS256算法签名JWT
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(secret))
}

// ValidateJWT 验证JWT令牌
func ValidateJWT(tokenString string, secret string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		// 验证签名算法
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(secret), nil
	})

	if err != nil {
		return nil, err
	}

	// 验证令牌有效性并提取声明
	if claims, ok := token.Claims.(*Claims); ok && token.Valid {
		return claims, nil
	}

	return nil, fmt.Errorf("invalid token")
}

// GenerateSessionToken 生成会话令牌
func GenerateSessionToken() string {
	bytes := make([]byte, 32)
	rand.Read(bytes)
	return "sess_" + hex.EncodeToString(bytes)
}

// GenerateAPIKey 生成API密钥
func GenerateAPIKey() string {
	bytes := make([]byte, 32)
	rand.Read(bytes)
	return "ak_live_" + hex.EncodeToString(bytes)
}

// GenerateDeviceID 生成设备ID
func GenerateDeviceID() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return "dev_" + hex.EncodeToString(bytes)
}

// GenerateAgentID 生成代理ID
func GenerateAgentID() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return "agent_" + hex.EncodeToString(bytes)
}

// GenerateCommandID 生成命令ID
func GenerateCommandID() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return "cmd_" + hex.EncodeToString(bytes)
}

// GenerateExecutionID 生成执行记录ID
func GenerateExecutionID() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return "exec_" + hex.EncodeToString(bytes)
}

// GenerateGroupID 生成群组ID
func GenerateGroupID() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return "grp_" + hex.EncodeToString(bytes)
}