package internal

import (
	"bytes"
	"context"
	"encoding/base64"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

type CommandExecutor struct {
	agent    *Agent
	stopChan chan struct{}
	wg       sync.WaitGroup
}

func NewCommandExecutor(agent *Agent) *CommandExecutor {
	return &CommandExecutor{
		agent:    agent,
		stopChan: make(chan struct{}),
	}
}

func (e *CommandExecutor) Start() {
	e.wg.Add(1)
	go e.processCommands()
}

func (e *CommandExecutor) Stop() {
	close(e.stopChan)
	e.wg.Wait()
}

func (e *CommandExecutor) processCommands() {
	defer e.wg.Done()

	for {
		select {
		case cmd := <-e.agent.commandQueue:
			e.executeCommand(cmd)
		case <-e.stopChan:
			return
		}
	}
}

func (e *CommandExecutor) executeCommand(cmd *Command) {
	logrus.Infof("Executing command: %s", cmd.CommandID)

	startTime := time.Now()
	
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(cmd.Timeout)*time.Second)
	defer cancel()

	shellCmd := exec.CommandContext(ctx, "sh", "-c", cmd.Content)
	
	for key, value := range cmd.EnvVars {
		shellCmd.Env = append(shellCmd.Env, key+"="+value)
	}

	var stdout, stderr bytes.Buffer
	shellCmd.Stdout = &stdout
	shellCmd.Stderr = &stderr

	err := shellCmd.Run()
	
	exitCode := 0
	status := "completed"
	output := stdout.String()
	
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			status = "timeout"
			exitCode = -1
		} else {
			status = "failed"
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			} else {
				exitCode = -1
			}
		}
		output += "\n" + stderr.String()
	}

	output = strings.TrimSpace(output)
	if len(output) > 10000 {
		output = output[:10000] + "\n... (truncated)"
	}

	completedAt := time.Now()
	
	result := &ExecutionResult{
		ExecutionID: cmd.ExecutionID,
		DeviceID:    e.agent.deviceID,
		Status:      status,
		ExitCode:    exitCode,
		Output:      output,
		Log:         base64.StdEncoding.EncodeToString([]byte(output)),
		CompletedAt: completedAt.Format(time.RFC3339),
	}

	if err := e.agent.ReportResult(result); err != nil {
		logrus.Error("Failed to report result:", err)
	}

	duration := completedAt.Sub(startTime)
	logrus.Infof("Command %s completed in %v with status: %s", cmd.CommandID, duration, status)
}