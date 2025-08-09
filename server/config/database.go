// config 包负责处理应用程序的配置管理
package config

import (
	"fmt"
	"time"

	"github.com/XRSec/Cslite/models"
	"github.com/XRSec/Cslite/utils"
	"github.com/sirupsen/logrus"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// DB 是全局数据库连接实例
var DB *gorm.DB

// InitDatabase 初始化数据库连接
func InitDatabase() error {
	var err error

	// 配置GORM日志模式
	gormConfig := &gorm.Config{
		Logger: logger.Default.LogMode(logger.Info),
	}

	// 在生产环境中只记录错误日志
	if AppConfig.Mode == "production" {
		gormConfig.Logger = logger.Default.LogMode(logger.Error)
	}

	// 连接到MySQL数据库
	DB, err = gorm.Open(mysql.Open(AppConfig.DBDsn), gormConfig)
	if err != nil {
		return fmt.Errorf("failed to connect to database: %w", err)
	}

	// 获取底层的sql.DB实例以配置连接池
	sqlDB, err := DB.DB()
	if err != nil {
		return fmt.Errorf("failed to get database instance: %w", err)
	}

	// 配置数据库连接池参数
	sqlDB.SetMaxIdleConns(10)           // 最大空闲连接数
	sqlDB.SetMaxOpenConns(100)          // 最大打开连接数
	sqlDB.SetConnMaxLifetime(time.Hour) // 连接最大生命周期

	logrus.Info("Connected to database successfully")

	// 运行数据库迁移
	if err := autoMigrate(); err != nil {
		return fmt.Errorf("failed to auto migrate: %w", err)
	}

	// 创建默认用户（如果不存在）
	if err := createDefaultUser(); err != nil {
		return fmt.Errorf("failed to create default user: %w", err)
	}

	return nil
}

// autoMigrate 自动迁移数据库表结构
func autoMigrate() error {
	logrus.Info("Running database migrations...")
	return DB.AutoMigrate(
		&models.User{},            // 用户表
		&models.Session{},         // 会话表
		&models.APIKey{},          // API密钥表
		&models.Device{},          // 设备表
		&models.Agent{},           // 代理表
		&models.Group{},           // 分组表
		&models.Command{},         // 命令表
		&models.Execution{},       // 执行记录表
		&models.ExecutionResult{}, // 执行结果表
	)
}

// createDefaultUser 创建默认用户（如果不存在）
func createDefaultUser() error {
	var count int64
	if err := DB.Model(&models.User{}).Count(&count).Error; err != nil {
		return fmt.Errorf("failed to count users: %w", err)
	}

	// 如果用户数量为0，创建默认管理员用户
	if count == 0 {
		logrus.Info("No users found, creating default admin user...")

		// 对密码进行哈希加密
		hashedPassword, err := utils.HashPassword("admin")
		if err != nil {
			return fmt.Errorf("failed to hash password: %w", err)
		}

		// 创建默认管理员用户
		defaultUser := &models.User{
			Username: "admin",
			Password: hashedPassword,
			Email:    "admin@cslite.local",
			Role:     models.RoleAdmin,
		}

		if err := DB.Create(defaultUser).Error; err != nil {
			return fmt.Errorf("failed to create default user: %w", err)
		}

		logrus.Info("Default admin user created successfully")
		logrus.Info("Username: admin")
		logrus.Info("Password: admin")
		logrus.Info("Please change the password after first login!")
	} else {
		logrus.Info("Users exist, skipping default user creation")
	}

	return nil
}
