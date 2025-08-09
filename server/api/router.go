// api 包定义了HTTP API路由和处理函数
package api

import (
	"path/filepath"
	"strings"

	"github.com/XRSec/Cslite/middleware"
	"github.com/gin-gonic/gin"
	"github.com/XRSec/Cslite/config"
)

// SetupRoutes 设置所有API路由
func SetupRoutes(router *gin.Engine) {
	// 启动数据库初始化（后台执行）
	config.StartDatabaseInitialization()

	// 全局中间件：数据库就绪检查
	router.Use(middleware.DBReadyOrServiceUnavailable())
	// 健康检查端点
	router.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{
			"status":  "ok",
			"message": "Cslite server is running",
		})
	})

	// 为根路径提供index.html并处理SPA路由
	router.GET("/", func(c *gin.Context) {
		// 设置不缓存头，确保SPA页面始终获取最新版本
		c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
		c.Header("Pragma", "no-cache")
		c.Header("Expires", "0")
		c.File("./static/index.html")
	})

	// 提供静态文件服务，包含缓存头
	router.Static("/static", "./static")

	// 处理静态资源，设置适当的缓存策略
	router.Use(func(c *gin.Context) {
		path := c.Request.URL.Path

		// 为静态资源应用缓存头
		if strings.HasPrefix(path, "/static/") {
			ext := strings.ToLower(filepath.Ext(path))

			switch ext {
			case ".js", ".css":
				// JS和CSS文件缓存1小时
				c.Header("Cache-Control", "public, max-age=3600")
			case ".jpg", ".jpeg", ".png", ".gif", ".svg", ".ico":
				// 图片文件缓存7天
				c.Header("Cache-Control", "public, max-age=604800")
			case ".html":
				// HTML文件不缓存
				c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
				c.Header("Pragma", "no-cache")
				c.Header("Expires", "0")
			default:
				// 其他静态文件默认缓存1小时
				c.Header("Cache-Control", "public, max-age=3600")
			}
		}

		c.Next()
	})

	// 创建API路由组
	api := router.Group("/api")

	// 认证相关路由
	authHandler := NewAuthHandler()

	authGroup := api.Group("/auth")
	{
		authGroup.POST("/login", authHandler.Login)                                       // 用户登录
		authGroup.POST("/logout", middleware.AuthRequired(), authHandler.Logout)          // 用户登出
		authGroup.POST("/key", middleware.AuthRequired(), authHandler.GenerateAPIKey)     // 生成API密钥
		authGroup.POST("/user", middleware.AdminRequired(), authHandler.CreateUser)       // 创建用户（管理员）
		authGroup.GET("/user", middleware.AdminRequired(), authHandler.ListUsers)         // 列出用户（管理员）
		authGroup.DELETE("/user/:id", middleware.AdminRequired(), authHandler.DeleteUser) // 删除用户（管理员）
	}

	// 设备管理路由
	deviceHandler := NewDeviceHandler()

	devicesGroup := api.Group("/devices")
	devicesGroup.Use(middleware.AuthRequired()) // 需要认证
	{
		devicesGroup.POST("", deviceHandler.CreateDevice)          // 创建设备
		devicesGroup.GET("", deviceHandler.ListDevices)            // 列出设备
		devicesGroup.GET("/:id", deviceHandler.GetDevice)          // 获取设备详情
		devicesGroup.DELETE("", deviceHandler.DeleteDevices)       // 删除设备
		devicesGroup.GET("/status", deviceHandler.GetDeviceStatus) // 获取设备状态
	}

	// 分组管理路由
	groupHandler := NewGroupHandler()

	groupsGroup := api.Group("/groups")
	groupsGroup.Use(middleware.AuthRequired()) // 需要认证
	{
		groupsGroup.POST("", groupHandler.CreateGroup)                  // 创建分组
		groupsGroup.GET("", groupHandler.ListGroups)                    // 列出分组
		groupsGroup.PUT("/:id/devices", groupHandler.AddDevicesToGroup) // 添加设备到分组
		groupsGroup.DELETE("/:id", groupHandler.DeleteGroup)            // 删除分组
	}

	// 命令管理路由
	commandHandler := NewCommandHandler()

	commandsGroup := api.Group("/commands")
	commandsGroup.Use(middleware.AuthRequired()) // 需要认证
	{
		commandsGroup.POST("", commandHandler.CreateCommand)                // 创建命令
		commandsGroup.GET("", commandHandler.ListCommands)                  // 列出命令
		commandsGroup.GET("/:id", commandHandler.GetCommand)                // 获取命令详情
		commandsGroup.PUT("/:id", commandHandler.UpdateCommandStatus)       // 更新命令状态
		commandsGroup.GET("/:id/results", commandHandler.GetCommandResults) // 获取命令执行结果
	}

	// 代理通信路由（无需认证）
	agentHandler := NewAgentHandler()

	agentGroup := api.Group("/agent")
	{
		agentGroup.POST("/register", agentHandler.Register)    // 代理注册
		agentGroup.POST("/heartbeat", agentHandler.Heartbeat)  // 代理心跳
		agentGroup.GET("/commands", agentHandler.PollCommands) // 代理轮询命令
		agentGroup.POST("/result", agentHandler.ReportResult)  // 代理报告结果
	}

	// 日志管理路由
	logHandler := NewLogHandler()

	logsGroup := api.Group("/logs")
	logsGroup.Use(middleware.AuthRequired()) // 需要认证
	{
		logsGroup.GET("/command", logHandler.GetCommandLogs)                       // 获取命令日志
		logsGroup.GET("/device", logHandler.GetDeviceLogs)                         // 获取设备日志
		logsGroup.GET("/user", middleware.AdminRequired(), logHandler.GetUserLogs) // 获取用户日志（管理员）
		logsGroup.GET("/download/:log_id", logHandler.DownloadLog)                 // 下载日志文件
	}
}
