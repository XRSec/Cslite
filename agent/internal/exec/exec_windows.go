//go:build windows

package exec

import (
	"context"
	"errors"
	"fmt"
	osexec "os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/XRSec/Cslite/agent/internal/protocol"
)

func buildWindowsCommand(shell, content string) (string, []string, error) {
	s := strings.ToLower(strings.TrimSpace(shell))
	switch s {
	case "", "cmd", "cmd.exe":
		return "cmd.exe", []string{"/C", "chcp 65001>nul & " + content}, nil
	case "powershell", "powershell.exe", "pwsh":
		bin := "powershell.exe"
		if s == "pwsh" {
			bin = "pwsh.exe"
		}
		script := "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " + content
		return bin, []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script}, nil
	default:
		return "", nil, unsupportedShellErr(shell)
	}
}

func runWithContext(ctx context.Context, req Request) Result {
	bin, args, err := buildWindowsCommand(req.Shell, req.Content)
	if err != nil {
		return Result{
			Status:   protocol.StatusFailed,
			ExitCode: -1,
			Output:   err.Error(),
		}
	}

	cmd := osexec.Command(bin, args...)
	// Initialize environment with os.Environ() FIRST before applying task env_vars.
	cmd.Env = MergeEnv(baseEnv(), req.EnvVars, true)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}

	outBuf := newCappedBuffer(bufferCapBytes)
	cmd.Stdout = outBuf
	cmd.Stderr = outBuf

	if err := cmd.Start(); err != nil {
		return Result{
			Status:   protocol.StatusFailed,
			ExitCode: -1,
			Output:   fmt.Sprintf("failed to start command: %v", err),
		}
	}

	pid := cmd.Process.Pid
	waitDone := make(chan error, 1)
	go func() {
		waitDone <- cmd.Wait()
	}()

	select {
	case err := <-waitDone:
		if err == nil {
			return Result{
				Status:   protocol.StatusCompleted,
				ExitCode: 0,
				Output:   formatOutput(outBuf, nil, MaxOutputBytes),
			}
		}
		exitCode := -1
		var exitErr *osexec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		}
		return Result{
			Status:   protocol.StatusFailed,
			ExitCode: exitCode,
			Output:   formatOutput(outBuf, nil, MaxOutputBytes),
		}

	case <-ctx.Done():
		killCmd := osexec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid))
		killCmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err := killCmd.Run(); err != nil {
			_ = cmd.Process.Kill()
		}

		drainTimer := time.NewTimer(2 * time.Second)
		select {
		case <-waitDone:
			drainTimer.Stop()
		case <-drainTimer.C:
		}

		return Result{
			Status:   contextOutcome(ctx),
			ExitCode: -1,
			Output:   formatOutput(outBuf, nil, MaxOutputBytes),
		}
	}
}
