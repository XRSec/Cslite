package main

import (
	"fmt"
	"log"

	"github.com/cslite/cslite/server/api"
	"github.com/cslite/cslite/server/config"
	"github.com/cslite/cslite/server/internal/command"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

func main() {
	if err := config.LoadConfig(); err != nil {
		log.Fatal("Failed to load config:", err)
	}

	setupLogger()

	if err := config.InitDatabase(); err != nil {
		logrus.Fatal("Failed to initialize database:", err)
	}

	if config.AppConfig.Mode == "production" {
		gin.SetMode(gin.ReleaseMode)
	}

	router := gin.Default()
	api.SetupRoutes(router)

	if config.AppConfig.CronEnabled {
		scheduler := command.NewScheduler()
		if err := scheduler.Start(); err != nil {
			logrus.Error("Failed to start command scheduler:", err)
		} else {
			logrus.Info("Command scheduler started successfully")
		}
		defer scheduler.Stop()
	}

	addr := fmt.Sprintf(":%s", config.AppConfig.Port)
	logrus.Infof("Starting Cslite server on %s", addr)
	
	if err := router.Run(addr); err != nil {
		logrus.Fatal("Failed to start server:", err)
	}
}

func setupLogger() {
	level, err := logrus.ParseLevel(config.AppConfig.LogLevel)
	if err != nil {
		level = logrus.InfoLevel
	}
	
	logrus.SetLevel(level)
	
	if config.AppConfig.Mode == "production" {
		logrus.SetFormatter(&logrus.JSONFormatter{})
	} else {
		logrus.SetFormatter(&logrus.TextFormatter{
			FullTimestamp: true,
		})
	}
}