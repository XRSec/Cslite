// config 包负责处理应用程序的配置管理
package config

import "errors"

// 配置相关的错误定义
var (
	ErrMissingDBDsn     = errors.New("missing database DSN") // 缺少数据库连接字符串
	ErrMissingSecretKey = errors.New("missing secret key")   // 缺少应用密钥
	ErrMissingJWTSecret = errors.New("missing JWT secret")   // 缺少JWT签名密钥
)
