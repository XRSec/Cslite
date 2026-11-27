//go:build !windows

package exec

import (
	"context"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/XRSec/Cslite/agent/internal/protocol"
)

func TestExecuteTimeoutKillsBackgroundGrandchild(t *testing.T) {
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	res := runWithContext(ctx, Request{
		Content: "sleep 30 & spid=$!; echo PID=$spid; wait",
	})
	elapsed := time.Since(start)

	if res.Status != protocol.StatusTimeout {
		t.Fatalf("Status = %q, want %q (output=%q)", res.Status, protocol.StatusTimeout, res.Output)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("timeout took too long: %v", elapsed)
	}

	idx := strings.Index(res.Output, "PID=")
	if idx < 0 {
		t.Fatalf("expected PID output from grandchild, got %q", res.Output)
	}
	pidStr := strings.Fields(res.Output[idx+4:])[0]
	spid, err := strconv.Atoi(pidStr)
	if err != nil {
		t.Fatalf("parse grandchild pid %q: %v", pidStr, err)
	}

	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(spid, 0); err == syscall.ESRCH {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	_ = syscall.Kill(spid, syscall.SIGKILL)
	t.Fatalf("grandchild sleep process %d survived process-group kill", spid)
}
