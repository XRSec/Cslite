package config

import (
	"fmt"
	"time"

	"github.com/cslite/cslite/server/models"
	"github.com/sirupsen/logrus"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var DB *gorm.DB

func InitDatabase() error {
	var err error
	
	gormConfig := &gorm.Config{
		Logger: logger.Default.LogMode(logger.Info),
	}
	
	if AppConfig.Mode == "production" {
		gormConfig.Logger = logger.Default.LogMode(logger.Error)
	}

	DB, err = gorm.Open(mysql.Open(AppConfig.DBDsn), gormConfig)
	if err != nil {
		return fmt.Errorf("failed to connect to database: %w", err)
	}

	sqlDB, err := DB.DB()
	if err != nil {
		return fmt.Errorf("failed to get database instance: %w", err)
	}

	sqlDB.SetMaxIdleConns(10)
	sqlDB.SetMaxOpenConns(100)
	sqlDB.SetConnMaxLifetime(time.Hour)

	logrus.Info("Connected to database successfully")

	if err := autoMigrate(); err != nil {
		return fmt.Errorf("failed to auto migrate: %w", err)
	}

	return nil
}

func autoMigrate() error {
	logrus.Info("Running database migrations...")
	
	return DB.AutoMigrate(
		&models.User{},
		&models.Session{},
		&models.APIKey{},
		&models.Device{},
		&models.Agent{},
		&models.Group{},
		&models.Command{},
		&models.Execution{},
		&models.ExecutionResult{},
	)
}