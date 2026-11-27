package exec

import (
	"context"
	"os"
	"runtime"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/XRSec/Cslite/agent/internal/protocol"
)

func TestExecutePreservesEnvironAndMergesEnvVars(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix shell test")
	}

	res := Execute(context.Background(), Request{
		Content: `printf "%s|%s" "$PATH" "$CSLITE_TEST_VAR"`,
		Timeout: 5,
		EnvVars: map[string]string{
			"CSLITE_TEST_VAR": "hello_world",
		},
	})

	if res.Status != protocol.StatusCompleted || res.ExitCode != 0 {
		t.Fatalf("unexpected result: %+v", res)
	}
	parts := strings.SplitN(res.Output, "|", 2)
	if len(parts) != 2 {
		t.Fatalf("unexpected output format: %q", res.Output)
	}
	if parts[0] == "" || parts[0] != os.Getenv("PATH") {
		t.Fatalf("PATH not preserved: got %q, want %q", parts[0], os.Getenv("PATH"))
	}
	if parts[1] != "hello_world" {
		t.Fatalf("CSLITE_TEST_VAR = %q, want hello_world", parts[1])
	}
}

func TestSanitizeAndTruncateUTF8(t *testing.T) {
	// Invalid UTF-8 bytes should be replaced cleanly.
	rawInvalid := "ok-\xff\xfe-end"
	sanitized := SanitizeAndTruncate(rawInvalid, 1024)
	if !utf8.ValidString(sanitized) {
		t.Fatalf("sanitized output is not valid UTF-8: %q", sanitized)
	}

	// Multi-byte UTF-8 truncation at exact boundary must not split rune.
	repeated := strings.Repeat("测", 70000) // 210,000 bytes > MaxOutputBytes (204,800)
	truncated := SanitizeAndTruncate(repeated, MaxOutputBytes)
	if len(truncated) > MaxOutputBytes {
		t.Fatalf("truncated length %d exceeds MaxOutputBytes %d", len(truncated), MaxOutputBytes)
	}
	if !utf8.ValidString(truncated) {
		t.Fatalf("truncated string is invalid UTF-8")
	}
	if !strings.HasSuffix(truncated, truncSuffix) {
		t.Fatalf("expected truncation suffix")
	}
}
