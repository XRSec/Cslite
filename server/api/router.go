package api

import (
	"github.com/cslite/cslite/server/middleware"
	"github.com/gin-gonic/gin"
)

func SetupRoutes(router *gin.Engine) {
	api := router.Group("/")
	
	authHandler := NewAuthHandler()
	
	authGroup := api.Group("/auth")
	{
		authGroup.POST("/login", authHandler.Login)
		authGroup.POST("/logout", middleware.AuthRequired(), authHandler.Logout)
		authGroup.POST("/key", middleware.AuthRequired(), authHandler.GenerateAPIKey)
		authGroup.POST("/user", middleware.AdminRequired(), authHandler.CreateUser)
		authGroup.GET("/user", middleware.AdminRequired(), authHandler.ListUsers)
		authGroup.DELETE("/user/:id", middleware.AdminRequired(), authHandler.DeleteUser)
	}

	deviceHandler := NewDeviceHandler()
	
	devicesGroup := api.Group("/devices")
	devicesGroup.Use(middleware.AuthRequired())
	{
		devicesGroup.POST("", deviceHandler.CreateDevice)
		devicesGroup.GET("", deviceHandler.ListDevices)
		devicesGroup.GET("/:id", deviceHandler.GetDevice)
		devicesGroup.DELETE("", deviceHandler.DeleteDevices)
		devicesGroup.GET("/status", deviceHandler.GetDeviceStatus)
	}

	groupHandler := NewGroupHandler()
	
	groupsGroup := api.Group("/groups")
	groupsGroup.Use(middleware.AuthRequired())
	{
		groupsGroup.POST("", groupHandler.CreateGroup)
		groupsGroup.GET("", groupHandler.ListGroups)
		groupsGroup.PUT("/:id/devices", groupHandler.AddDevicesToGroup)
		groupsGroup.DELETE("/:id", groupHandler.DeleteGroup)
	}

	commandHandler := NewCommandHandler()
	
	commandsGroup := api.Group("/commands")
	commandsGroup.Use(middleware.AuthRequired())
	{
		commandsGroup.POST("", commandHandler.CreateCommand)
		commandsGroup.GET("", commandHandler.ListCommands)
		commandsGroup.GET("/:id", commandHandler.GetCommand)
		commandsGroup.PUT("/:id", commandHandler.UpdateCommandStatus)
		commandsGroup.GET("/:id/results", commandHandler.GetCommandResults)
	}

	agentHandler := NewAgentHandler()
	
	agentGroup := api.Group("/agent")
	{
		agentGroup.POST("/register", agentHandler.Register)
		agentGroup.POST("/heartbeat", agentHandler.Heartbeat)
		agentGroup.GET("/commands", agentHandler.PollCommands)
		agentGroup.POST("/result", agentHandler.ReportResult)
	}

	logHandler := NewLogHandler()
	
	logsGroup := api.Group("/logs")
	logsGroup.Use(middleware.AuthRequired())
	{
		logsGroup.GET("/command", logHandler.GetCommandLogs)
		logsGroup.GET("/device", logHandler.GetDeviceLogs)
		logsGroup.GET("/user", middleware.AdminRequired(), logHandler.GetUserLogs)
		logsGroup.GET("/download/:log_id", logHandler.DownloadLog)
	}
}