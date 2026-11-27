//go:build !windows

package exec

import (
	"context"
	"errors"
	"fmt"
	osexec "os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/XRSec/Cslite/agent/internal/protocol"
)

func resolveUnixShell(shell string) (string, error) {
	s := strings.TrimSpace(shell)
	switch s {
	case "", "sh", "/bin/sh":
		if p, err := osexec.LookPath("/bin/sh"); err == nil {
			return p, nil
		}
		return osexec.LookPath("sh")
	case "ash", "/bin/ash":
		if p, err := osexec.LookPath("/bin/ash"); err == nil {
			return p, nil
		}
		if p, err := osexec.LookPath("ash"); err == nil {
			return p, nil
		}
		// BusyBox systems often expose ash as /bin/sh.
		return osexec.LookPath("/bin/sh")
	case "bash", "/bin/bash", "/usr/bin/bash":
		return osexec.LookPath("bash")
	case "zsh", "/bin/zsh", "/usr/bin/zsh":
		return osexec.LookPath("zsh")
	default:
		return "", unsupportedShellErr(shell)
	}
}

func runWithContext(ctx context.Context, req Request) Result {
	shellPath, err := resolveUnixShell(req.Shell)
	if err != nil {
		return Result{
			Status:   protocol.StatusFailed,
			ExitCode: -1,
			Output:   err.Error(),
		}
	}

	cmd := osexec.Command(shellPath, "-c", req.Content)
	// Initialize environment with os.Environ() FIRST before applying task env_vars.
	cmd.Env = MergeEnv(baseEnv(), req.EnvVars, false)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

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

	pgid := cmd.Process.Pid
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
		// Kill the entire process group so backgrounded grandchildren cannot leak or hold pipes open.
		_ = syscall.Kill(-pgid, syscall.SIGKILL)

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
