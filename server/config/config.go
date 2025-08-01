package config

import (
	"os"
	"strconv"

	"github.com/joho/godotenv"
	"github.com/sirupsen/logrus"
)

type Config struct {
	Port           string
	Mode           string
	LogLevel       string
	DBDsn          string
	SecretKey      string
	JWTSecret      string
	APIRateLimit   int
	AllowRegister  bool
	FileDir        string
	CronEnabled    bool
	HeartbeatInterval int
	CommandPollInterval int
}

var AppConfig *Config

func LoadConfig() error {
	if err := godotenv.Load(); err != nil {
		logrus.Warn("No .env file found, using environment variables")
	}

	AppConfig = &Config{
		Port:      getEnv("CSLITE_PORT", "8080"),
		Mode:      getEnv("CSLITE_MODE", "development"),
		LogLevel:  getEnv("CSLITE_LOG_LEVEL", "info"),
		DBDsn:     getEnv("CSLITE_DB_DSN", ""),
		SecretKey: getEnv("CSLITE_SECRET_KEY", ""),
		JWTSecret: getEnv("CSLITE_JWT_SECRET", ""),
		FileDir:   getEnv("CSLITE_FILE_DIR", "/var/cslite/files"),
	}

	AppConfig.APIRateLimit = getEnvAsInt("CSLITE_API_RATE_LIMIT", 60)
	AppConfig.AllowRegister = getEnvAsBool("CSLITE_ALLOW_REGISTER", true)
	AppConfig.CronEnabled = getEnvAsBool("CSLITE_CRON_ENABLED", true)
	AppConfig.HeartbeatInterval = getEnvAsInt("AGENT_HEARTBEAT_INTERVAL", 60)
	AppConfig.CommandPollInterval = getEnvAsInt("AGENT_COMMAND_POLL_INTERVAL", 30)

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

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvAsInt(key string, defaultValue int) int {
	strValue := getEnv(key, "")
	if value, err := strconv.Atoi(strValue); err == nil {
		return value
	}
	return defaultValue
}

func getEnvAsBool(key string, defaultValue bool) bool {
	strValue := getEnv(key, "")
	if value, err := strconv.ParseBool(strValue); err == nil {
		return value
	}
	return defaultValue
}