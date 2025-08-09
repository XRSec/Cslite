// main 包是Cslite服务器的主入口点
package main

import (
	"fmt"
	"log"

	"github.com/XRSec/Cslite/api"
	"github.com/XRSec/Cslite/config"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

// main 函数是应用程序的入口点
func main() {
	// 加载配置文件
	if err := config.LoadConfig(); err != nil {
		log.Fatal("Failed to load config:", err)
	}

	// 设置日志记录器
	setupLogger()

	// 初始化数据库连接
	if err := config.InitDatabase(); err != nil {
		logrus.Fatal("Failed to initialize database:", err)
	}

	// 在生产模式下设置Gin为发布模式
	if config.AppConfig.Mode == "production" {
		gin.SetMode(gin.ReleaseMode)
	}

	// 创建Gin路由器并设置API路由
	router := gin.Default()
	api.SetupRoutes(router)

	// 构建服务器地址并启动服务器
	addr := fmt.Sprintf(":%s", config.AppConfig.Port)
	logrus.Infof("Starting Cslite server on http://127.0.0.1%s", addr)

	if err := router.Run(addr); err != nil {
		logrus.Fatal("Failed to start server:", err)
	}
}

// setupLogger 设置日志记录器的配置
func setupLogger() {
	// 解析日志级别
	level, err := logrus.ParseLevel(config.AppConfig.LogLevel)
	if err != nil {
		// 如果解析失败，默认使用Info级别
		level = logrus.InfoLevel
	}

	// 设置日志级别
	logrus.SetLevel(level)

	// 根据运行模式设置日志格式
	if config.AppConfig.Mode == "production" {
		// 生产环境使用JSON格式
		logrus.SetFormatter(&logrus.JSONFormatter{})
	} else {
		// 开发环境使用文本格式，包含完整时间戳
		logrus.SetFormatter(&logrus.TextFormatter{
			FullTimestamp: true,
		})
	}
}
