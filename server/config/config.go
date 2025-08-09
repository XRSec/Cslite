// config 包负责处理应用程序的配置管理
package config

import (
	"os"
	"strconv"

	"github.com/joho/godotenv"
	"github.com/sirupsen/logrus"
)

// Config 结构体定义了应用程序的所有配置项
type Config struct {
	Port                string // 服务器监听端口
	Mode                string // 运行模式（development/production）
	LogLevel            string // 日志级别
	DBDsn               string // 数据库连接字符串
	SecretKey           string // 应用密钥
	JWTSecret           string // JWT签名密钥
	APIRateLimit        int    // API速率限制
	AllowRegister       bool   // 是否允许用户注册
	FileDir             string // 文件存储目录
	HeartbeatInterval   int    // 心跳间隔（秒）
	CommandPollInterval int    // 命令轮询间隔（秒）
}

// AppConfig 是全局配置实例
var AppConfig *Config

// LoadConfig 加载应用程序配置
func LoadConfig() error {
	// 尝试加载.env文件
	if err := godotenv.Load(); err != nil {
		logrus.Warn("No .env file found, using environment variables")
	}

	// 创建配置实例并设置默认值
	AppConfig = &Config{
		Port:      getEnv("CSLITE_PORT", "8080"),
		Mode:      getEnv("CSLITE_MODE", "development"),
		LogLevel:  getEnv("CSLITE_LOG_LEVEL", "info"),
		DBDsn:     getEnv("CSLITE_DB_DSN", ""),
		SecretKey: getEnv("CSLITE_SECRET_KEY", ""),
		JWTSecret: getEnv("CSLITE_JWT_SECRET", ""),
		FileDir:   getEnv("CSLITE_FILE_DIR", "/var/cslite/files"),
	}

	// 设置整数类型的配置项
	AppConfig.APIRateLimit = getEnvAsInt("CSLITE_API_RATE_LIMIT", 60)
	AppConfig.AllowRegister = getEnvAsBool("CSLITE_ALLOW_REGISTER", true)
	AppConfig.HeartbeatInterval = getEnvAsInt("AGENT_HEARTBEAT_INTERVAL", 60)
	AppConfig.CommandPollInterval = getEnvAsInt("AGENT_COMMAND_POLL_INTERVAL", 30)

	// 验证必需的配置项
	if AppConfig.DBDsn == "" {
		return ErrMissingDBDsn
	}
	if AppConfig.SecretKey == "" {
		return ErrMissingSecretKey
	}
	if AppConfig.JWTSecret == "" {
		return ErrMissingJWTSecret
	}

	return nil
}

// getEnv 从环境变量获取字符串值，如果不存在则返回默认值
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

// getEnvAsInt 从环境变量获取整数值，如果不存在或解析失败则返回默认值
func getEnvAsInt(key string, defaultValue int) int {
	strValue := getEnv(key, "")
	if value, err := strconv.Atoi(strValue); err == nil {
		return value
	}
	return defaultValue
}

// getEnvAsBool 从环境变量获取布尔值，如果不存在或解析失败则返回默认值
func getEnvAsBool(key string, defaultValue bool) bool {
	strValue := getEnv(key, "")
	if value, err := strconv.ParseBool(strValue); err == nil {
		return value
	}
	return defaultValue
}
