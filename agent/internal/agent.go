package internal

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

type Agent struct {
	config       *Config
	client       *http.Client
	agentID      string
	deviceID     string
	stopChan     chan struct{}
	wg           sync.WaitGroup
	commandQueue chan *Command
	executor     *CommandExecutor
}

type Config struct {
	ServerURL           string
	APIKey              string
	HeartbeatInterval   int
	CommandPollInterval int
	LogPath             string
}

func NewAgent(config *Config) (*Agent, error) {
	agent := &Agent{
		config: config,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
		stopChan:     make(chan struct{}),
		commandQueue: make(chan *Command, 10),
	}

	agent.executor = NewCommandExecutor(agent)

	if err := agent.loadOrRegister(); err != nil {
		return nil, fmt.Errorf("failed to register agent: %w", err)
	}

	return agent, nil
}

func (a *Agent) Start() error {
	a.wg.Add(3)
	
	go a.heartbeatLoop()
	go a.commandPollLoop()
	go a.executor.Start()

	return nil
}

func (a *Agent) Stop() {
	close(a.stopChan)
	a.wg.Wait()
	a.executor.Stop()
}

func (a *Agent) loadOrRegister() error {
	stateFile := "/var/lib/cslite/agent.state"
	
	data, err := os.ReadFile(stateFile)
	if err == nil {
		var state struct {
			AgentID  string `json:"agent_id"`
			DeviceID string `json:"device_id"`
		}
		if err := json.Unmarshal(data, &state); err == nil {
			a.agentID = state.AgentID
			a.deviceID = state.DeviceID
			logrus.Info("Loaded existing agent state")
			return nil
		}
	}

	hostname, _ := os.Hostname()
	platform := getPlatform()

	req := RegisterRequest{
		Name:     hostname,
		Platform: platform,
		Version:  "v1.0.0",
	}

	resp, err := a.apiCall("POST", "/agent/register", req)
	if err != nil {
		return err
	}

	var result struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    struct {
			AgentID  string `json:"agent_id"`
			DeviceID string `json:"device_id"`
		} `json:"data"`
	}

	if err := json.Unmarshal(resp, &result); err != nil {
		return err
	}

	if result.Code != 20000 {
		return fmt.Errorf("registration failed: %s", result.Message)
	}

	a.agentID = result.Data.AgentID
	a.deviceID = result.Data.DeviceID

	state := map[string]string{
		"agent_id":  a.agentID,
		"device_id": a.deviceID,
	}
	stateData, _ := json.Marshal(state)
	os.MkdirAll("/var/lib/cslite", 0755)
	os.WriteFile(stateFile, stateData, 0600)

	logrus.Info("Agent registered successfully")
	return nil
}

func (a *Agent) heartbeatLoop() {
	defer a.wg.Done()

	ticker := time.NewTicker(time.Duration(a.config.HeartbeatInterval) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			if err := a.sendHeartbeat(); err != nil {
				logrus.Error("Failed to send heartbeat:", err)
			}
		case <-a.stopChan:
			return
		}
	}
}

func (a *Agent) sendHeartbeat() error {
	metrics := collectMetrics()
	
	req := HeartbeatRequest{
		AgentID:   a.agentID,
		Metrics:   metrics,
		Timestamp: time.Now().Format(time.RFC3339),
	}

	_, err := a.apiCall("POST", "/agent/heartbeat", req)
	if err != nil {
		return err
	}

	logrus.Debug("Heartbeat sent successfully")
	return nil
}

func (a *Agent) commandPollLoop() {
	defer a.wg.Done()

	ticker := time.NewTicker(time.Duration(a.config.CommandPollInterval) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			if err := a.pollCommands(); err != nil {
				logrus.Error("Failed to poll commands:", err)
			}
		case <-a.stopChan:
			return
		}
	}
}

func (a *Agent) pollCommands() error {
	resp, err := a.apiCall("GET", fmt.Sprintf("/agent/commands?agent_id=%s", a.agentID), nil)
	if err != nil {
		return err
	}

	var result struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    struct {
			Commands []Command `json:"commands"`
		} `json:"data"`
	}

	if err := json.Unmarshal(resp, &result); err != nil {
		return err
	}

	if result.Code != 20000 {
		return fmt.Errorf("failed to poll commands: %s", result.Message)
	}

	for _, cmd := range result.Data.Commands {
		select {
		case a.commandQueue <- &cmd:
			logrus.Infof("Queued command: %s", cmd.CommandID)
		default:
			logrus.Warn("Command queue full, dropping command")
		}
	}

	return nil
}

func (a *Agent) ReportResult(result *ExecutionResult) error {
	_, err := a.apiCall("POST", "/agent/result", result)
	if err != nil {
		return err
	}

	logrus.Infof("Reported result for execution: %s", result.ExecutionID)
	return nil
}

func (a *Agent) apiCall(method, path string, body interface{}) ([]byte, error) {
	url := a.config.ServerURL + path

	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reqBody = bytes.NewBuffer(data)
	}

	req, err := http.NewRequest(method, url, reqBody)
	if err != nil {
		return nil, err
	}

	req.Header.Set("X-API-Key", a.config.APIKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := a.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	return io.ReadAll(resp.Body)
}