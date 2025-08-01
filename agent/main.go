package main

import (
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/cslite/cslite/agent/internal"
	"github.com/joho/godotenv"
	"github.com/sirupsen/logrus"
)

func main() {
	var (
		configFile = flag.String("config", ".env", "Configuration file path")
		server     = flag.String("server", "", "Server URL")
		apiKey     = flag.String("apikey", "", "API Key")
		interval   = flag.Int("interval", 60, "Heartbeat interval in seconds")
		logLevel   = flag.String("loglevel", "info", "Log level (debug, info, warn, error)")
	)
	flag.Parse()

	if err := godotenv.Load(*configFile); err != nil {
		logrus.Debug("No config file found, using command line arguments")
	}

	setupLogger(*logLevel)

	config := &internal.Config{
		ServerURL:           getEnvOrFlag("AGENT_SERVER", *server),
		APIKey:              getEnvOrFlag("AGENT_KEY", *apiKey),
		HeartbeatInterval:   *interval,
		CommandPollInterval: 30,
		LogPath:             getEnvOrFlag("AGENT_LOG_PATH", "/var/log/cslite-agent.log"),
	}

	if config.ServerURL == "" || config.APIKey == "" {
		log.Fatal("Server URL and API Key are required")
	}

	agent, err := internal.NewAgent(config)
	if err != nil {
		log.Fatal("Failed to create agent:", err)
	}

	if err := agent.Start(); err != nil {
		log.Fatal("Failed to start agent:", err)
	}

	logrus.Info("Cslite Agent started successfully")

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	logrus.Info("Shutting down agent...")
	agent.Stop()
}

func setupLogger(level string) {
	logLevel, err := logrus.ParseLevel(level)
	if err != nil {
		logLevel = logrus.InfoLevel
	}
	
	logrus.SetLevel(logLevel)
	logrus.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})
}

func getEnvOrFlag(envKey, flagValue string) string {
	if value := os.Getenv(envKey); value != "" {
		return value
	}
	return flagValue
}