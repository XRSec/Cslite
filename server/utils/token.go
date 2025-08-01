package utils

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/cslite/cslite/server/config"
	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	UserID   uint   `json:"user_id"`
	Username string `json:"username"`
	Role     int    `json:"role"`
	jwt.RegisteredClaims
}

func GenerateJWT(userID uint, username string, role int) (string, error) {
	claims := &Claims{
		UserID:   userID,
		Username: username,
		Role:     role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(7 * 24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(config.AppConfig.JWTSecret))
}

func ValidateJWT(tokenString string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(config.AppConfig.JWTSecret), nil
	})

	if err != nil {
		return nil, err
	}

	if claims, ok := token.Claims.(*Claims); ok && token.Valid {
		return claims, nil
	}

	return nil, fmt.Errorf("invalid token")
}

func GenerateSessionToken() string {
	bytes := make([]byte, 32)
	rand.Read(bytes)
	return "sess_" + hex.EncodeToString(bytes)
}

func GenerateAPIKey() string {
	bytes := make([]byte, 32)
	rand.Read(bytes)
	return "ak_live_" + hex.EncodeToString(bytes)
}

func GenerateDeviceID() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return "dev_" + hex.EncodeToString(bytes)
}

func GenerateAgentID() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return "agent_" + hex.EncodeToString(bytes)
}

func GenerateCommandID() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return "cmd_" + hex.EncodeToString(bytes)
}

func GenerateExecutionID() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return "exec_" + hex.EncodeToString(bytes)
}

func GenerateGroupID() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return "grp_" + hex.EncodeToString(bytes)
}