// Package exec implements cross-platform command execution with tree termination and UTF-8 output limits.
package exec

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/XRSec/Cslite/agent/internal/protocol"
)

const (
	// DefaultTimeout is used when a command specifies timeout <= 0.
	DefaultTimeout = 600
	// MaxOutputBytes limits reported plain UTF-8 output to 200 KiB.
	MaxOutputBytes = 200 * 1024
	// bufferCapBytes caps in-memory capture before truncation to protect low-RAM devices.
	bufferCapBytes = 256 * 1024
	truncSuffix    = "\n... (truncated)"
)

// Request describes a command execution request.
type Request struct {
	Content string
	Timeout int
	Shell   string
	EnvVars map[string]string
}

// Result contains the outcome of a command execution.
type Result struct {
	Status   string
	ExitCode int
	Output   string
}

// Execute runs the requested command honoring timeout/cancellation and env vars.
func Execute(ctx context.Context, req Request) Result {
	if strings.TrimSpace(req.Content) == "" {
		return Result{
			Status:   protocol.StatusFailed,
			ExitCode: -1,
			Output:   "empty command content",
		}
	}
	timeoutSec := req.Timeout
	if timeoutSec <= 0 {
		timeoutSec = DefaultTimeout
	}

	execCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSec)*time.Second)
	defer cancel()

	return runWithContext(execCtx, req)
}

// MergeEnv initializes environment from base (e.g. os.Environ()) and overlays overrides.
func MergeEnv(base []string, overrides map[string]string, caseInsensitive bool) []string {
	env := make([]string, 0, len(base)+len(overrides))
	env = append(env, base...)
	if len(overrides) == 0 {
		return env
	}

	for k, v := range overrides {
		if k == "" || strings.ContainsRune(k, '=') || strings.ContainsRune(k, '\x00') {
			continue
		}
		replaced := false
		for i, existing := range env {
			idx := strings.IndexByte(existing, '=')
			if idx <= 0 {
				continue
			}
			ek := existing[:idx]
			if ek == k || (caseInsensitive && strings.EqualFold(ek, k)) {
				env[i] = k + "=" + v
				replaced = true
				break
			}
		}
		if !replaced {
			env = append(env, k+"="+v)
		}
	}
	return env
}

// SanitizeAndTruncate ensures valid UTF-8 and truncates safely at rune boundaries within maxBytes.
func SanitizeAndTruncate(raw string, maxBytes int) string {
	valid := strings.ToValidUTF8(raw, "\ufffd")
	valid = strings.TrimRight(valid, " \t\r\n")
	if maxBytes <= 0 || len(valid) <= maxBytes {
		return valid
	}
	if maxBytes <= len(truncSuffix) {
		cut := maxBytes
		for cut > 0 && !utf8.RuneStart(valid[cut]) {
			cut--
		}
		return valid[:cut]
	}
	cut := maxBytes - len(truncSuffix)
	for cut > 0 && !utf8.RuneStart(valid[cut]) {
		cut--
	}
	return valid[:cut] + truncSuffix
}

func formatOutput(buf *cappedBuffer, extraErr error, maxBytes int) string {
	raw := buf.String()
	if extraErr != nil {
		if raw != "" {
			raw += "\n" + extraErr.Error()
		} else {
			raw = extraErr.Error()
		}
	}
	out := SanitizeAndTruncate(raw, maxBytes)
	if buf.Overflowed() && !strings.HasSuffix(out, truncSuffix) {
		if len(out)+len(truncSuffix) <= maxBytes {
			out += truncSuffix
		} else {
			out = SanitizeAndTruncate(out+truncSuffix, maxBytes)
		}
	}
	return out
}

func contextOutcome(ctx context.Context) string {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return protocol.StatusTimeout
	}
	return protocol.StatusCancelled
}

func baseEnv() []string {
	return os.Environ()
}

type cappedBuffer struct {
	mu         sync.Mutex
	buf        bytes.Buffer
	limit      int
	overflowed bool
}

func newCappedBuffer(limit int) *cappedBuffer {
	return &cappedBuffer{limit: limit}
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	totalLen := len(p)
	if b.limit <= 0 {
		b.overflowed = true
		return totalLen, nil
	}
	rem := b.limit - b.buf.Len()
	if rem <= 0 {
		b.overflowed = true
		return totalLen, nil
	}
	if len(p) > rem {
		_, _ = b.buf.Write(p[:rem])
		b.overflowed = true
		return totalLen, nil
	}
	_, _ = b.buf.Write(p)
	return totalLen, nil
}

func (b *cappedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func (b *cappedBuffer) Overflowed() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.overflowed
}

func unsupportedShellErr(shell string) error {
	return fmt.Errorf("unsupported shell %q", shell)
}
