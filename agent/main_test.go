package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	osexec "os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/XRSec/Cslite/agent/internal/config"
)

func TestBindCommonFlagsAPIKeyAliases(t *testing.T) {
	for _, flagName := range []string{"--key", "-key", "--apikey", "--api-key", "-api-key"} {
		fs := flag.NewFlagSet("test", flag.ContinueOnError)
		var ov config.Overrides
		bindCommonFlags(fs, &ov)
		if err := fs.Parse([]string{"--server", "https://example.com", flagName, "ak_live_alias"}); err != nil {
			t.Fatalf("fs.Parse(%s) failed: %v", flagName, err)
		}
		if ov.APIKey != "ak_live_alias" {
			t.Fatalf("flag %s yielded APIKey=%q, want ak_live_alias", flagName, ov.APIKey)
		}
	}
}

func TestLiteShellUclientFetch404ReRegisterAndOnceError(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell test")
	}

	liteScript, err := filepath.Abs(filepath.Join("openwrt", "cslite-agent-lite.sh"))
	if err != nil {
		t.Fatalf("resolve lite script: %v", err)
	}

	t.Run("uclient-fetch 404 triggers 40010 re-register", func(t *testing.T) {
		var regCount, hbCount, pollCount, resCount atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			raw, _ := io.ReadAll(r.Body)
			switch r.URL.Path {
			case "/api/agent/register":
				var body map[string]any
				_ = json.Unmarshal(raw, &body)
				if body["api_key"] != "ak_live_uclient" {
					t.Errorf("register missing body api_key: %s", string(raw))
				}
				regCount.Add(1)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"code": 20000,
					"data": map[string]any{"agent_id": "ag_new", "device_id": "dev_new"},
				})
			case "/api/agent/heartbeat":
				var body map[string]any
				_ = json.Unmarshal(raw, &body)
				if body["agent_id"] == "ag_stale" {
					w.WriteHeader(http.StatusNotFound)
					_, _ = w.Write([]byte(`{"code":40010,"message":"device not found","data":null}`))
					return
				}
				hbCount.Add(1)
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 20000, "data": map[string]any{"status": "ok"}})
			case "/api/agent/commands":
				pollCount.Add(1)
				var body map[string]any
				_ = json.Unmarshal(raw, &body)
				if body["agent_id"] != "ag_new" || body["api_key"] != "ak_live_uclient" {
					t.Errorf("unexpected uclient-fetch POST poll body: %s", string(raw))
				}
				_ = json.NewEncoder(w).Encode(map[string]any{
					"code": 20000,
					"data": map[string]any{"commands": []map[string]any{{
						"result_id":    "res_uc_1",
						"command_id":   "cmd_uc_1",
						"execution_id": "exec_uc_1",
						"content":      "echo uclient_ok",
						"timeout":      5,
					}}},
				})
			case "/api/agent/result":
				resCount.Add(1)
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 20000, "data": map[string]any{"status": "received", "logged": true}})
			}
		}))
		defer srv.Close()

		tmpDir := t.TempDir()
		binDir := filepath.Join(tmpDir, "bin")
		cfgDir := filepath.Join(tmpDir, "cfg")
		if err := os.MkdirAll(binDir, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(cfgDir, 0755); err != nil {
			t.Fatal(err)
		}

		// Seed stale state to trigger HTTP 404 on first heartbeat.
		staleState, _ := json.Marshal(map[string]string{
			"agent_id":   "ag_stale",
			"device_id":  "dev_stale",
			"server_url": srv.URL + "/api",
		})
		if err := os.WriteFile(filepath.Join(cfgDir, "state.json"), staleState, 0600); err != nil {
			t.Fatal(err)
		}

		// Stub uclient-fetch simulating BusyBox exit non-zero + stderr "HTTP error 404" without saving body.
		stub := `#!/bin/sh
out=""
post=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -O) out="$2"; shift 2 ;;
    --post-data=*) post="${1#--post-data=}"; shift ;;
    -q) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [ -n "$post" ]; then
  code=$(curl -sS -o "$out.tmp" -w "%{http_code}" -X POST -H "Content-Type: application/json" -d "$post" "$url")
else
  code=$(curl -sS -o "$out.tmp" -w "%{http_code}" "$url")
fi
if [ "$code" = "404" ]; then
  rm -f "$out.tmp" "$out"
  echo "uclient-fetch: HTTP error 404: Not Found" >&2
  exit 1
fi
mv "$out.tmp" "$out"
exit 0
`
		if err := os.WriteFile(filepath.Join(binDir, "uclient-fetch"), []byte(stub), 0755); err != nil {
			t.Fatal(err)
		}

		cmd := osexec.Command("sh", liteScript, "run", "--server", srv.URL, "--api-key", "ak_live_uclient", "--once")
		cmd.Env = []string{
			"PATH=" + binDir + string(os.PathListSeparator) + os.Getenv("PATH"),
			"CSLITE_CONFIG_DIR=" + cfgDir,
			"CSLITE_HTTP_CLIENT=uclient-fetch",
		}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("lite uclient-fetch run failed: %v\n%s", err, string(out))
		}
		if regCount.Load() != 1 || hbCount.Load() != 1 || pollCount.Load() != 1 || resCount.Load() != 1 {
			t.Fatalf("unexpected counts reg=%d hb=%d poll=%d res=%d", regCount.Load(), hbCount.Load(), pollCount.Load(), resCount.Load())
		}
	})

	t.Run("wget 404 on poll triggers 40010 re-register and re-poll", func(t *testing.T) {
		var regCount, pollCount atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/agent/register":
				regCount.Add(1)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"code": 20000,
					"data": map[string]any{"agent_id": "ag_wget_new", "device_id": "dev_wget_new"},
				})
			case "/api/agent/heartbeat":
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 20000, "data": map[string]any{"status": "ok"}})
			case "/api/agent/commands":
				pollCount.Add(1)
				agID := r.URL.Query().Get("agent_id")
				if agID == "" {
					raw, _ := io.ReadAll(r.Body)
					var body map[string]any
					_ = json.Unmarshal(raw, &body)
					if s, ok := body["agent_id"].(string); ok {
						agID = s
					}
				}
				if agID == "ag_wget_stale" {
					w.WriteHeader(http.StatusNotFound)
					_, _ = w.Write([]byte(`{"code":40010,"message":"device not found"}`))
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 20000, "data": map[string]any{"commands": []any{}}})
			}
		}))
		defer srv.Close()

		tmpDir := t.TempDir()
		binDir := filepath.Join(tmpDir, "bin")
		cfgDir := filepath.Join(tmpDir, "cfg")
		_ = os.MkdirAll(binDir, 0755)
		_ = os.MkdirAll(cfgDir, 0755)

		staleState, _ := json.Marshal(map[string]string{
			"agent_id":   "ag_wget_stale",
			"device_id":  "dev_wget_stale",
			"server_url": srv.URL + "/api",
		})
		_ = os.WriteFile(filepath.Join(cfgDir, "state.json"), staleState, 0600)

		wgetStub := `#!/bin/sh
out=""
post=""
url=""
h1=""
h2=""
while [ $# -gt 0 ]; do
  case "$1" in
    -O) out="$2"; shift 2 ;;
    --post-data=*) post="${1#--post-data=}"; shift ;;
    --header=*) if [ -z "$h1" ]; then h1="${1#--header=}"; else h2="${1#--header=}"; fi; shift ;;
    -q) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [ -n "$post" ]; then
  code=$(curl -sS -o "$out.tmp" -w "%{http_code}" -X POST ${h1:+-H "$h1"} ${h2:+-H "$h2"} -d "$post" "$url")
else
  code=$(curl -sS -o "$out.tmp" -w "%{http_code}" ${h1:+-H "$h1"} ${h2:+-H "$h2"} "$url")
fi
if [ "$code" = "404" ]; then
  rm -f "$out.tmp" "$out"
  echo "wget: server returned error: HTTP/1.1 404 Not Found" >&2
  exit 1
fi
mv "$out.tmp" "$out"
exit 0
`
		if err := os.WriteFile(filepath.Join(binDir, "wget"), []byte(wgetStub), 0755); err != nil {
			t.Fatal(err)
		}

		cmd := osexec.Command("sh", liteScript, "run", "--server", srv.URL, "--api-key", "ak_live_wget", "--once")
		cmd.Env = []string{
			"PATH=" + binDir + string(os.PathListSeparator) + os.Getenv("PATH"),
			"CSLITE_CONFIG_DIR=" + cfgDir,
			"CSLITE_HTTP_CLIENT=wget",
		}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("lite wget run failed: %v\n%s", err, string(out))
		}
		if regCount.Load() != 1 || pollCount.Load() != 2 {
			t.Fatalf("expected 1 re-register and 2 polls, got reg=%d poll=%d", regCount.Load(), pollCount.Load())
		}
	})

	t.Run("--once preserves non-zero exit when poll fails", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/agent/register":
				_ = json.NewEncoder(w).Encode(map[string]any{
					"code": 20000,
					"data": map[string]any{"agent_id": "ag_err", "device_id": "dev_err"},
				})
			case "/api/agent/heartbeat":
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 20000, "data": map[string]any{"status": "ok"}})
			case "/api/agent/commands":
				w.WriteHeader(http.StatusInternalServerError)
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 50001, "message": "internal error"})
			}
		}))
		defer srv.Close()

		cfgDir := t.TempDir()
		cmd := osexec.Command("sh", liteScript, "run", "--server", srv.URL, "--api-key", "ak_live_err", "--once")
		cmd.Env = []string{
			"PATH=/usr/bin:/bin",
			"CSLITE_CONFIG_DIR=" + cfgDir,
		}
		if out, err := cmd.CombinedOutput(); err == nil {
			t.Fatalf("expected non-zero exit when poll_once fails, got exit 0:\n%s", string(out))
		}
	})
}

func TestInstallScriptPipedFallbackToLite(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell test")
	}

	installBytes, err := os.ReadFile(filepath.Join("scripts", "install.sh"))
	if err != nil {
		t.Fatalf("read install.sh: %v", err)
	}
	liteBytes, err := os.ReadFile(filepath.Join("openwrt", "cslite-agent-lite.sh"))
	if err != nil {
		t.Fatalf("read cslite-agent-lite.sh: %v", err)
	}

	var badBinHits, html200Hits, liteHits, regHits, hbHits, pollHits atomic.Int32
	var regName, regDevID, regPlatform atomic.Value

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/bad-bin":
			badBinHits.Add(1)
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte("<!doctype html><html><body>404 Not Found</body></html>"))
		case "/html-200-bin":
			html200Hits.Add(1)
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte("<!doctype html><html><body>SPA Fallback</body></html>"))
		case "/agent-lite.sh":
			liteHits.Add(1)
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, _ = w.Write(liteBytes)
		case "/api/agent/register":
			raw, _ := io.ReadAll(r.Body)
			var body map[string]any
			_ = json.Unmarshal(raw, &body)
			if s, ok := body["name"].(string); ok {
				regName.Store(s)
			}
			if s, ok := body["device_id"].(string); ok {
				regDevID.Store(s)
			}
			if s, ok := body["platform"].(string); ok {
				regPlatform.Store(s)
			}
			regHits.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 20000,
				"data": map[string]any{"agent_id": "ag_pipe_1", "device_id": "dev_test"},
			})
		case "/api/agent/heartbeat":
			hbHits.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 20000, "data": map[string]any{"status": "ok"}})
		case "/api/agent/commands":
			pollHits.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 20000, "data": map[string]any{"commands": []any{}}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	t.Run("404 HTML binary falls back to server agent-lite.sh and runs cleanly", func(t *testing.T) {
		tmpDir := t.TempDir()
		installDir := filepath.Join(tmpDir, "bin")
		cfgDir := filepath.Join(tmpDir, "cfg")
		homeDir := filepath.Join(tmpDir, "home")
		_ = os.MkdirAll(homeDir, 0755)

		cmd := osexec.Command("sh", "-s", "--",
			"--server", srv.URL,
			"--key", "ak_test_pipe",
			"--device-id", "dev_test",
			"--name", "openwrt-hz-ys",
			"--bin-url", srv.URL+"/bad-bin",
		)
		cmd.Stdin = bytes.NewReader(installBytes)
		cmd.Env = []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=" + homeDir,
			"TMPDIR=" + tmpDir,
			"CSLITE_INSTALL_DIR=" + installDir,
			"CSLITE_CONFIG_DIR=" + cfgDir,
			"CSLITE_SKIP_SERVICE_EXEC=1",
		}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("piped install.sh failed: %v\n%s", err, string(out))
		}
		if badBinHits.Load() < 1 || liteHits.Load() != 1 {
			t.Fatalf("expected badBinHits>=1 and liteHits=1, got bad=%d lite=%d", badBinHits.Load(), liteHits.Load())
		}
		if _, err := os.Stat(filepath.Join(installDir, "cslite-agent")); !os.IsNotExist(err) {
			t.Fatalf("invalid binary should not be installed at cslite-agent")
		}

		installedLite := filepath.Join(installDir, "cslite-agent-lite")
		info, err := os.Stat(installedLite)
		if err != nil {
			t.Fatalf("expected cslite-agent-lite installed: %v", err)
		}
		if info.Mode()&0111 == 0 {
			t.Fatalf("expected executable permissions on %s, got mode %v", installedLite, info.Mode())
		}

		cfgRaw, err := os.ReadFile(filepath.Join(cfgDir, "config.json"))
		if err != nil {
			t.Fatalf("read config.json: %v", err)
		}
		var cfg map[string]any
		if err := json.Unmarshal(cfgRaw, &cfg); err != nil {
			t.Fatalf("invalid config.json: %v\n%s", err, string(cfgRaw))
		}
		if cfg["server"] != srv.URL || cfg["api_key"] != "ak_test_pipe" || cfg["device_id"] != "dev_test" || cfg["name"] != "openwrt-hz-ys" {
			t.Fatalf("unexpected config.json contents: %v", cfg)
		}

		runCmd := osexec.Command(installedLite, "run", "--config", filepath.Join(cfgDir, "config.json"), "--once")
		runCmd.Env = []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=" + homeDir,
			"TMPDIR=" + tmpDir,
			"CSLITE_CONFIG_DIR=" + cfgDir,
		}
		runOut, err := runCmd.CombinedOutput()
		if err != nil {
			t.Fatalf("installed cslite-agent-lite --once failed: %v\n%s", err, string(runOut))
		}
		if regHits.Load() != 1 || hbHits.Load() != 1 || pollHits.Load() != 1 {
			t.Fatalf("unexpected agent lifecycle hits reg=%d hb=%d poll=%d", regHits.Load(), hbHits.Load(), pollHits.Load())
		}
		if got, _ := regDevID.Load().(string); got != "dev_test" {
			t.Fatalf("registered device_id=%q, want dev_test", got)
		}
		if got, _ := regName.Load().(string); got != "openwrt-hz-ys" {
			t.Fatalf("registered name=%q, want openwrt-hz-ys", got)
		}
	})

	t.Run("200 OK HTML binary rejected by magic bytes check", func(t *testing.T) {
		tmpDir := t.TempDir()
		installDir := filepath.Join(tmpDir, "bin")
		cfgDir := filepath.Join(tmpDir, "cfg")
		beforeLite := liteHits.Load()

		cmd := osexec.Command("sh", "-s", "--",
			"--server", srv.URL+"/api/",
			"--key", "ak_html_200",
			"--bin-url", srv.URL+"/html-200-bin",
		)
		cmd.Stdin = bytes.NewReader(installBytes)
		cmd.Env = []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=" + tmpDir,
			"TMPDIR=" + tmpDir,
			"CSLITE_INSTALL_DIR=" + installDir,
			"CSLITE_CONFIG_DIR=" + cfgDir,
			"CSLITE_SKIP_SERVICE_EXEC=1",
		}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("piped install.sh failed: %v\n%s", err, string(out))
		}
		if html200Hits.Load() < 1 || liteHits.Load() != beforeLite+1 {
			t.Fatalf("expected html200Hits>=1 and liteHits increment, got html200=%d liteDelta=%d", html200Hits.Load(), liteHits.Load()-beforeLite)
		}
		if _, err := os.Stat(filepath.Join(installDir, "cslite-agent")); !os.IsNotExist(err) {
			t.Fatalf("HTML 200 payload should not be installed as binary")
		}
		if _, err := os.Stat(filepath.Join(installDir, "cslite-agent-lite")); err != nil {
			t.Fatalf("expected fallback cslite-agent-lite: %v", err)
		}
	})

	t.Run("android installer fallback and platform detection", func(t *testing.T) {
		androidBytes, err := os.ReadFile(filepath.Join("scripts", "install-android.sh"))
		if err != nil {
			t.Fatalf("read install-android.sh: %v", err)
		}

		tmpDir := t.TempDir()
		termuxPrefix := filepath.Join(tmpDir, "usr")
		installDir := filepath.Join(tmpDir, "bin")
		cfgDir := filepath.Join(tmpDir, "cfg")
		_ = os.MkdirAll(filepath.Join(termuxPrefix, "tmp"), 0755)
		beforeLite := liteHits.Load()

		cmd := osexec.Command("sh", "-s", "--",
			"--server", srv.URL,
			"--key", "ak_android_test",
			"--device-id", "dev_android",
			"--name", "termux-phone",
			"--bin-url", srv.URL+"/bad-bin",
		)
		cmd.Stdin = bytes.NewReader(androidBytes)
		cmd.Env = []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=" + tmpDir,
			"PREFIX=" + termuxPrefix,
			"TERMUX_VERSION=0.118.0",
			"TMPDIR=" + filepath.Join(tmpDir, "missing-tmp"),
			"CSLITE_INSTALL_DIR=" + installDir,
			"CSLITE_CONFIG_DIR=" + cfgDir,
			"CSLITE_SKIP_SERVICE_EXEC=1",
		}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("piped install-android.sh failed: %v\n%s", err, string(out))
		}
		if liteHits.Load() != beforeLite+1 {
			t.Fatalf("expected android installer to download agent-lite.sh")
		}

		installedLite := filepath.Join(installDir, "cslite-agent-lite")
		runCmd := osexec.Command("sh", installedLite, "run", "--config", filepath.Join(cfgDir, "config.json"), "--once")
		runCmd.Env = []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=" + tmpDir,
			"PREFIX=" + termuxPrefix,
			"TERMUX_VERSION=0.118.0",
			"TMPDIR=" + filepath.Join(tmpDir, "missing-tmp"),
			"CSLITE_CONFIG_DIR=" + cfgDir,
		}
		runOut, err := runCmd.CombinedOutput()
		if err != nil {
			t.Fatalf("android cslite-agent-lite --once failed: %v\n%s", err, string(runOut))
		}
		if got, _ := regPlatform.Load().(string); !strings.EqualFold(got, "android") {
			t.Fatalf("registered platform=%q, want android", got)
		}
	})

	t.Run("positional invocation with server-baked DEFAULT_SERVER on install.sh", func(t *testing.T) {
		bakedScript := strings.ReplaceAll(string(installBytes), "__CSLITE_DEFAULT_SERVER__", srv.URL)
		if strings.Contains(bakedScript, "__CSLITE_DEFAULT_SERVER__") {
			t.Fatalf("baked install.sh still contains placeholder")
		}

		tmpDir := t.TempDir()
		installDir := filepath.Join(tmpDir, "bin")
		cfgDir := filepath.Join(tmpDir, "cfg")
		homeDir := filepath.Join(tmpDir, "home")
		_ = os.MkdirAll(homeDir, 0755)

		beforeLite := liteHits.Load()
		beforeReg := regHits.Load()

		cmd := osexec.Command("sh", "-s", "--", "ak_pos_key", "dev_pos_123")
		cmd.Stdin = strings.NewReader(bakedScript)
		cmd.Env = []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=" + homeDir,
			"TMPDIR=" + tmpDir,
			"CSLITE_INSTALL_DIR=" + installDir,
			"CSLITE_CONFIG_DIR=" + cfgDir,
			"CSLITE_BIN_URL=" + srv.URL + "/bad-bin",
			"CSLITE_SKIP_SERVICE_EXEC=1",
		}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("baked positional install.sh failed: %v\n%s", err, string(out))
		}
		if liteHits.Load() != beforeLite+1 {
			t.Fatalf("expected liteHits increment, got %d -> %d", beforeLite, liteHits.Load())
		}

		cfgRaw, err := os.ReadFile(filepath.Join(cfgDir, "config.json"))
		if err != nil {
			t.Fatalf("read config.json: %v", err)
		}
		var cfg map[string]any
		if err := json.Unmarshal(cfgRaw, &cfg); err != nil {
			t.Fatalf("invalid config.json: %v\n%s", err, string(cfgRaw))
		}
		if cfg["server"] != srv.URL || cfg["api_key"] != "ak_pos_key" || cfg["device_id"] != "dev_pos_123" || cfg["name"] != "" {
			t.Fatalf("unexpected positional config.json: %v", cfg)
		}

		runCmd := osexec.Command(filepath.Join(installDir, "cslite-agent-lite"), "run", "--config", filepath.Join(cfgDir, "config.json"), "--once")
		runCmd.Env = []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=" + homeDir,
			"TMPDIR=" + tmpDir,
			"CSLITE_CONFIG_DIR=" + cfgDir,
		}
		runOut, err := runCmd.CombinedOutput()
		if err != nil {
			t.Fatalf("positional cslite-agent-lite --once failed: %v\n%s", err, string(runOut))
		}
		if regHits.Load() != beforeReg+1 {
			t.Fatalf("expected register call, got %d -> %d", beforeReg, regHits.Load())
		}
		if got, _ := regDevID.Load().(string); got != "dev_pos_123" {
			t.Fatalf("registered device_id=%q, want dev_pos_123", got)
		}
	})

	t.Run("bare -- ignored, 3rd positional sets name, unknown -* flag fails exit 2, and android positional works", func(t *testing.T) {
		bakedScript := strings.ReplaceAll(string(installBytes), "__CSLITE_DEFAULT_SERVER__", srv.URL)
		tmpDir := t.TempDir()
		installDir := filepath.Join(tmpDir, "bin")
		cfgDir := filepath.Join(tmpDir, "cfg")

		cmd := osexec.Command("sh", "-s", "--", "--", "ak_pos_2", "dev_pos_2", "custom-node")
		cmd.Stdin = strings.NewReader(bakedScript)
		cmd.Env = []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=" + tmpDir,
			"TMPDIR=" + tmpDir,
			"CSLITE_INSTALL_DIR=" + installDir,
			"CSLITE_CONFIG_DIR=" + cfgDir,
			"CSLITE_LITE=1",
			"CSLITE_SKIP_SERVICE_EXEC=1",
		}
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("bare -- positional install.sh failed: %v\n%s", err, string(out))
		}
		cfgRaw, err := os.ReadFile(filepath.Join(cfgDir, "config.json"))
		if err != nil {
			t.Fatalf("read config.json: %v", err)
		}
		var cfg map[string]any
		if err := json.Unmarshal(cfgRaw, &cfg); err != nil {
			t.Fatalf("invalid config.json: %v", err)
		}
		if cfg["api_key"] != "ak_pos_2" || cfg["device_id"] != "dev_pos_2" || cfg["name"] != "custom-node" {
			t.Fatalf("unexpected bare -- config.json: %v", cfg)
		}

		badFlagCmd := osexec.Command("sh", "-s", "--", "--unknown-flag", "ak_key")
		badFlagCmd.Stdin = strings.NewReader(bakedScript)
		if out, err := badFlagCmd.CombinedOutput(); err == nil {
			t.Fatalf("expected unknown flag to fail, got exit 0:\n%s", string(out))
		} else if exitErr, ok := err.(*osexec.ExitError); !ok || exitErr.ExitCode() != 2 {
			t.Fatalf("expected exit code 2 for unknown flag, got %v\n%s", err, string(out))
		}

		androidBytes, err := os.ReadFile(filepath.Join("scripts", "install-android.sh"))
		if err != nil {
			t.Fatalf("read install-android.sh: %v", err)
		}
		bakedAndroid := strings.ReplaceAll(string(androidBytes), "__CSLITE_DEFAULT_SERVER__", srv.URL)
		if strings.Contains(bakedAndroid, "__CSLITE_DEFAULT_SERVER__") {
			t.Fatalf("baked install-android.sh still contains placeholder")
		}
		andDir := t.TempDir()
		termuxPrefix := filepath.Join(andDir, "usr")
		andBin := filepath.Join(andDir, "bin")
		andCfg := filepath.Join(andDir, "cfg")
		_ = os.MkdirAll(filepath.Join(termuxPrefix, "tmp"), 0755)
		andCmd := osexec.Command("sh", "-s", "--", "ak_and_pos", "dev_and_pos")
		andCmd.Stdin = strings.NewReader(bakedAndroid)
		andCmd.Env = []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=" + andDir,
			"PREFIX=" + termuxPrefix,
			"TERMUX_VERSION=0.118.0",
			"TMPDIR=" + tmpDir,
			"CSLITE_INSTALL_DIR=" + andBin,
			"CSLITE_CONFIG_DIR=" + andCfg,
			"CSLITE_LITE=1",
			"CSLITE_SKIP_SERVICE_EXEC=1",
		}
		if out, err := andCmd.CombinedOutput(); err != nil {
			t.Fatalf("baked positional install-android.sh failed: %v\n%s", err, string(out))
		}
		andCfgRaw, err := os.ReadFile(filepath.Join(andCfg, "config.json"))
		if err != nil {
			t.Fatalf("read android config.json: %v", err)
		}
		var andCfgMap map[string]any
		if err := json.Unmarshal(andCfgRaw, &andCfgMap); err != nil {
			t.Fatalf("invalid android config.json: %v", err)
		}
		if andCfgMap["server"] != srv.URL || andCfgMap["api_key"] != "ak_and_pos" || andCfgMap["device_id"] != "dev_and_pos" {
			t.Fatalf("unexpected android positional config.json: %v", andCfgMap)
		}

		// Backward compatibility: CSLITE_* env vars work with zero CLI args
		envCfg := filepath.Join(andDir, "env-cfg")
		envCmd := osexec.Command("sh", "-s")
		envCmd.Stdin = strings.NewReader(string(installBytes))
		envCmd.Env = []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=" + andDir,
			"TMPDIR=" + tmpDir,
			"CSLITE_SERVER=" + srv.URL,
			"CSLITE_API_KEY=ak_env_compat",
			"CSLITE_DEVICE_ID=dev_env_compat",
			"CSLITE_NAME=env-router",
			"CSLITE_INSTALL_DIR=" + andBin,
			"CSLITE_CONFIG_DIR=" + envCfg,
			"CSLITE_LITE=1",
			"CSLITE_SKIP_SERVICE_EXEC=1",
		}
		if out, err := envCmd.CombinedOutput(); err != nil {
			t.Fatalf("env-var compat install.sh failed: %v\n%s", err, string(out))
		}
		envCfgRaw, err := os.ReadFile(filepath.Join(envCfg, "config.json"))
		if err != nil {
			t.Fatalf("read env compat config.json: %v", err)
		}
		var envCfgMap map[string]any
		if err := json.Unmarshal(envCfgRaw, &envCfgMap); err != nil {
			t.Fatalf("invalid env compat config.json: %v", err)
		}
		if envCfgMap["server"] != srv.URL || envCfgMap["api_key"] != "ak_env_compat" || envCfgMap["device_id"] != "dev_env_compat" || envCfgMap["name"] != "env-router" {
			t.Fatalf("unexpected env compat config.json: %v", envCfgMap)
		}
	})
}

func extractLiteLibrary(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("openwrt", "cslite-agent-lite.sh"))
	if err != nil {
		t.Fatalf("read cslite-agent-lite.sh: %v", err)
	}
	content := string(raw)
	idx := strings.Index(content, "\nSUBCMD=")
	if idx < 0 {
		t.Fatalf("could not find SUBCMD dispatcher in cslite-agent-lite.sh")
	}
	libPath := filepath.Join(t.TempDir(), "lite-lib.sh")
	if err := os.WriteFile(libPath, []byte(content[:idx]+"\n"), 0644); err != nil {
		t.Fatalf("write lite-lib.sh: %v", err)
	}
	return libPath
}

func TestLiteShellNoJshnSelfHealAndJsonQuote(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell test")
	}

	liteScript, err := filepath.Abs(filepath.Join("openwrt", "cslite-agent-lite.sh"))
	if err != nil {
		t.Fatalf("resolve lite script: %v", err)
	}
	liteBytes, err := os.ReadFile(liteScript)
	if err != nil {
		t.Fatalf("read lite script: %v", err)
	}
	liteText := string(liteBytes)

	t.Run("zero references to jshn.sh", func(t *testing.T) {
		if strings.Contains(liteText, "jshn.sh") || strings.Contains(liteText, "/usr/share/libubox/jshn.sh") {
			t.Fatalf("cslite-agent-lite.sh must not reference jshn.sh")
		}
	})

	t.Run("cmd_install self-heals corrupt config.json and state.json", func(t *testing.T) {
		cfgDir := t.TempDir()
		corruptCfg := `{
  "server": { "v": "https:\/\/cs.xrsec.fun" ,
  "api_key": { "v": "ak_old_corrupt" ,
  "name": { "v": "old-router" ,
  "device_id": { "v": "dev_old" ,
  "poll_interval": { "v": "99" ,
  "heartbeat_interval": { "v": "120" ,
  "log_level": { "v": "debug"
}
`
		corruptState := `{
  "agent_id": { "v": "ag_bad" ,
  "device_id": { "v": "dev_bad" ,
  "server_url": { "v": "https:\/\/cs.xrsec.fun\/api"
}
`
		cfgPath := filepath.Join(cfgDir, "config.json")
		statePath := filepath.Join(cfgDir, "state.json")
		if err := os.WriteFile(cfgPath, []byte(corruptCfg), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(statePath, []byte(corruptState), 0600); err != nil {
			t.Fatal(err)
		}

		cmd := osexec.Command("sh", liteScript, "install",
			"--server", "https://cs.xrsec.fun",
			"--key", "ak_live_test_123",
			"--device-id", "dev_4c75175ca92add5c",
			"--name", "openwrt-hz-ys",
		)
		cmd.Env = []string{
			"PATH=" + os.Getenv("PATH"),
			"TMPDIR=" + cfgDir,
			"CSLITE_CONFIG_DIR=" + cfgDir,
			"CSLITE_SKIP_SERVICE_EXEC=1",
		}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("cmd_install failed: %v\n%s", err, string(out))
		}

		if _, err := os.Stat(statePath); !os.IsNotExist(err) {
			t.Fatalf("expected corrupt state.json to be removed, stat err=%v", err)
		}

		fixedRaw, err := os.ReadFile(cfgPath)
		if err != nil {
			t.Fatalf("read config.json: %v", err)
		}
		fixedStr := string(fixedRaw)
		if strings.Contains(fixedStr, `{ "v":`) || strings.Contains(fixedStr, `\/`) {
			t.Fatalf("config.json still contains corrupt fragments:\n%s", fixedStr)
		}

		var cfg struct {
			Server            string `json:"server"`
			APIKey            string `json:"api_key"`
			DeviceID          string `json:"device_id"`
			Name              string `json:"name"`
			PollInterval      int    `json:"poll_interval"`
			HeartbeatInterval int    `json:"heartbeat_interval"`
			LogLevel          string `json:"log_level"`
		}
		if err := json.Unmarshal(fixedRaw, &cfg); err != nil {
			t.Fatalf("invalid config.json: %v\n%s", err, fixedStr)
		}
		if cfg.Server != "https://cs.xrsec.fun" ||
			cfg.APIKey != "ak_live_test_123" ||
			cfg.DeviceID != "dev_4c75175ca92add5c" ||
			cfg.Name != "openwrt-hz-ys" ||
			cfg.PollInterval != 5 ||
			cfg.HeartbeatInterval != 60 ||
			cfg.LogLevel != "info" {
			t.Fatalf("unexpected repaired config: %+v", cfg)
		}
	})

	t.Run("cmd_install with --server and --key ignores stale existing config fields", func(t *testing.T) {
		cfgDir := t.TempDir()
		staleCfg := `{
  "server": "https://old.example.com",
  "api_key": "ak_stale",
  "name": "stale-name",
  "device_id": "dev_stale",
  "poll_interval": 99,
  "heartbeat_interval": 300,
  "log_level": "debug"
}
`
		cfgPath := filepath.Join(cfgDir, "config.json")
		if err := os.WriteFile(cfgPath, []byte(staleCfg), 0600); err != nil {
			t.Fatal(err)
		}

		cmd := osexec.Command("sh", liteScript, "install",
			"--server", "https://cs.xrsec.fun",
			"--key", "ak_fresh_456",
		)
		cmd.Env = []string{
			"PATH=" + os.Getenv("PATH"),
			"TMPDIR=" + cfgDir,
			"CSLITE_CONFIG_DIR=" + cfgDir,
			"CSLITE_SKIP_SERVICE_EXEC=1",
		}
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("cmd_install failed: %v\n%s", err, string(out))
		}

		fixedRaw, err := os.ReadFile(cfgPath)
		if err != nil {
			t.Fatal(err)
		}
		var cfg struct {
			Server            string `json:"server"`
			APIKey            string `json:"api_key"`
			DeviceID          string `json:"device_id"`
			Name              string `json:"name"`
			PollInterval      int    `json:"poll_interval"`
			HeartbeatInterval int    `json:"heartbeat_interval"`
			LogLevel          string `json:"log_level"`
		}
		if err := json.Unmarshal(fixedRaw, &cfg); err != nil {
			t.Fatalf("invalid config.json: %v\n%s", err, string(fixedRaw))
		}
		if cfg.Server != "https://cs.xrsec.fun" ||
			cfg.APIKey != "ak_fresh_456" ||
			cfg.DeviceID != "" ||
			cfg.Name != "" ||
			cfg.PollInterval != 5 ||
			cfg.HeartbeatInterval != 60 ||
			cfg.LogLevel != "info" {
			t.Fatalf("expected clean defaults without stale inheritance, got %+v", cfg)
		}
	})

	t.Run("json_quote handles URLs, quotes, and backslashes as valid JSON", func(t *testing.T) {
		libPath := extractLiteLibrary(t)
		cases := []string{
			"https://cs.xrsec.fun",
			`edge "router" 01`,
			`C:\openwrt\bin\agent`,
			`mix "quotes" and \backslashes\ and https://cs.xrsec.fun/i`,
			"100%\tok",
			"",
		}
		for _, tc := range cases {
			cmd := osexec.Command("sh", "-c", `. "$1" && json_quote "$2"`, "sh", libPath, tc)
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("json_quote(%q) failed: %v\n%s", tc, err, string(out))
			}
			quoted := string(out)
			if strings.Contains(quoted, `\/`) {
				t.Fatalf("json_quote(%q) needlessly escaped '/': %s", tc, quoted)
			}
			var decoded struct {
				Value string `json:"value"`
			}
			wrapped := `{"value":` + quoted + `}`
			if err := json.Unmarshal([]byte(wrapped), &decoded); err != nil {
				t.Fatalf("json_quote(%q) produced invalid JSON %s: %v", tc, quoted, err)
			}
			if decoded.Value != tc {
				t.Fatalf("json_quote(%q) round-trip got %q", tc, decoded.Value)
			}
		}
	})

	t.Run("load_config sanitizes corrupt {}-prefixed fields", func(t *testing.T) {
		libPath := extractLiteLibrary(t)
		cfgDir := t.TempDir()
		corruptValCfg := `{
  "server": "{ \"v\": \"https://bad.example\" }",
  "api_key": "{ \"v\": \"ak_bad\" }",
  "name": " { \"v\": \"bad_name\" }",
  "device_id": "{ \"v\": \"dev_bad\" }",
  "poll_interval": "{ \"v\": 5 }",
  "heartbeat_interval": "0",
  "log_level": "{ \"v\": \"debug\" }"
}
`
		if err := os.WriteFile(filepath.Join(cfgDir, "config.json"), []byte(corruptValCfg), 0600); err != nil {
			t.Fatal(err)
		}

		cmd := osexec.Command("sh", "-c", `. "$1" && load_config && printf '%s|%s|%s|%s|%s|%s|%s' "$SERVER" "$API_KEY" "$DEVICE_NAME" "$DEVICE_ID" "$POLL_INTERVAL" "$HEARTBEAT_INTERVAL" "$LOG_LEVEL"`, "sh", libPath)
		cmd.Env = []string{
			"PATH=" + os.Getenv("PATH"),
			"TMPDIR=" + cfgDir,
			"CSLITE_CONFIG_DIR=" + cfgDir,
		}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("load_config failed: %v\n%s", err, string(out))
		}
		if got := string(out); got != "||||5|60|info" {
			t.Fatalf("expected sanitized fields '||||5|60|info', got %q", got)
		}
	})

	t.Run("probe_http_client rejects BusyBox/uclient-like wget and falls through to uclient-fetch", func(t *testing.T) {
		libPath := extractLiteLibrary(t)
		binDir := t.TempDir()

		busyboxWget := "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then\n  echo 'BusyBox v1.36.1 multi-call binary.'\n  echo 'Usage: wget [-cqS] [-O FILE] [-T SEC] URL'\n  exit 0\nfi\nexit 1\n"
		uclientStub := "#!/bin/sh\nexit 0\n"
		if err := os.WriteFile(filepath.Join(binDir, "wget"), []byte(busyboxWget), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(binDir, "uclient-fetch"), []byte(uclientStub), 0755); err != nil {
			t.Fatal(err)
		}

		cmd := osexec.Command("sh", "-c", `. "$1" && probe_http_client && printf '%s' "$HTTP_CLIENT"`, "sh", libPath)
		// Ensure host curl isn't picked if /usr/bin has curl by isolating PATH to binDir + minimal tools
		cleanBin := t.TempDir()
		for _, tool := range []string{"cat", "tr", "sed", "awk", "mkdir", "rm", "dirname"} {
			if p, lookErr := osexec.LookPath(tool); lookErr == nil {
				_ = os.Symlink(p, filepath.Join(cleanBin, tool))
			}
		}
		cmd.Env = []string{"PATH=" + binDir + ":" + cleanBin}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("probe_http_client failed: %v\n%s", err, string(out))
		}
		if got := string(out); got != "uclient-fetch" {
			t.Fatalf("expected probe_http_client to fall through to uclient-fetch, got %q", got)
		}

		gnuWget := "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then\n  echo '  --header=STRING         insert STRING among the headers'\n  echo '  --post-data=STRING      use the POST method; send STRING as the data'\n  exit 0\nfi\nexit 1\n"
		if err := os.WriteFile(filepath.Join(binDir, "wget"), []byte(gnuWget), 0755); err != nil {
			t.Fatal(err)
		}
		cmd2 := osexec.Command("sh", "-c", `. "$1" && probe_http_client && printf '%s' "$HTTP_CLIENT"`, "sh", libPath)
		cmd2.Env = []string{"PATH=" + binDir + ":" + cleanBin}
		out2, err := cmd2.CombinedOutput()
		if err != nil {
			t.Fatalf("probe_http_client gnu wget failed: %v\n%s", err, string(out2))
		}
		if got := string(out2); got != "wget" {
			t.Fatalf("expected probe_http_client to pick full wget, got %q", got)
		}
	})

	t.Run("install.sh BusyBox wget fallback avoids -t flag and produces valid config.json", func(t *testing.T) {
		installBytes, err := os.ReadFile(filepath.Join("scripts", "install.sh"))
		if err != nil {
			t.Fatal(err)
		}
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/bad-bin":
				w.WriteHeader(http.StatusNotFound)
			case "/agent-lite.sh":
				_, _ = w.Write(liteBytes)
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		}))
		defer srv.Close()

		tmpDir := t.TempDir()
		binDir := filepath.Join(tmpDir, "bin")
		installDir := filepath.Join(tmpDir, "inst")
		cfgDir := filepath.Join(tmpDir, "cfg")
		_ = os.MkdirAll(binDir, 0755)

		// Symlink core POSIX tools so host curl is excluded and BusyBox-like wget is selected.
		for _, tool := range []string{"sh", "cat", "cp", "mv", "rm", "chmod", "mkdir", "dirname", "sed", "tr", "awk", "dd", "od", "wc", "uname", "id"} {
			if p, lookErr := osexec.LookPath(tool); lookErr == nil {
				_ = os.Symlink(p, filepath.Join(binDir, tool))
			}
		}
		curlBin, err := osexec.LookPath("curl")
		if err != nil {
			t.Skip("host curl needed for BusyBox wget mock transport")
		}
		bbWget := `#!/bin/sh
if [ "$1" = "--help" ]; then
  printf 'Usage: wget [-q] [-O FILE] [-T SEC] URL\n\t-T SEC\tNetwork read timeout\n'
  exit 0
fi
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -q) shift ;;
    -T) shift 2 ;;
    -O) out="$2"; shift 2 ;;
    -t) echo "wget: unrecognized option: t" >&2; exit 1 ;;
    *) url="$1"; shift ;;
  esac
done
exec "` + curlBin + `" -fsSL -o "$out" "$url"
`
		if err := os.WriteFile(filepath.Join(binDir, "wget"), []byte(bbWget), 0755); err != nil {
			t.Fatal(err)
		}

		cmd := osexec.Command("sh", "-s", "--",
			"--server", srv.URL,
			"--key", "ak_bb_wget",
			"--device-id", "dev_bb_wget",
			"--name", "bb-router",
			"--bin-url", srv.URL+"/bad-bin",
		)
		cmd.Stdin = bytes.NewReader(installBytes)
		cmd.Env = []string{
			"PATH=" + binDir,
			"HOME=" + tmpDir,
			"TMPDIR=" + tmpDir,
			"CSLITE_DOWNLOADER=wget",
			"CSLITE_INSTALL_DIR=" + installDir,
			"CSLITE_CONFIG_DIR=" + cfgDir,
			"CSLITE_SKIP_SERVICE_EXEC=1",
		}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("install.sh with BusyBox wget failed: %v\n%s", err, string(out))
		}
		if !strings.Contains(string(out), "Go binary release not available") {
			t.Fatalf("expected reassuring fallback log message, got:\n%s", string(out))
		}

		cfgRaw, err := os.ReadFile(filepath.Join(cfgDir, "config.json"))
		if err != nil {
			t.Fatal(err)
		}
		var cfg map[string]any
		if err := json.Unmarshal(cfgRaw, &cfg); err != nil {
			t.Fatalf("invalid config.json: %v\n%s", err, string(cfgRaw))
		}
		if cfg["server"] != srv.URL || cfg["api_key"] != "ak_bb_wget" || cfg["device_id"] != "dev_bb_wget" || cfg["name"] != "bb-router" {
			t.Fatalf("unexpected config.json: %v", cfg)
		}
	})
}

func extractInstallLibrary(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("scripts", "install.sh"))
	if err != nil {
		t.Fatalf("read install.sh: %v", err)
	}
	content := string(raw)
	idx := strings.Index(content, "\nOS=\"$(detect_os)\"")
	if idx < 0 {
		t.Fatalf("could not find OS detection block in install.sh")
	}
	// Strip the top CLI argument parsing / required --server check so functions can be sourced cleanly.
	fnStart := strings.Index(content, "\nis_writable_dir()")
	if fnStart < 0 || fnStart >= idx {
		t.Fatalf("could not locate is_writable_dir in install.sh")
	}
	libPath := filepath.Join(t.TempDir(), "install-lib.sh")
	if err := os.WriteFile(libPath, []byte(content[fnStart+1:idx]+"\n"), 0644); err != nil {
		t.Fatalf("write install-lib.sh: %v", err)
	}
	return libPath
}

func TestStrippedOpenWrtSupport(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell test")
	}

	t.Run("probe_http_client skips Chaos Calmer HTTP-only wget and selects openssl", func(t *testing.T) {
		libPath := extractLiteLibrary(t)
		binDir := t.TempDir()
		cleanBin := t.TempDir()
		for _, tool := range []string{"cat", "tr", "sed", "awk", "mkdir", "rm", "dirname"} {
			if p, lookErr := osexec.LookPath(tool); lookErr == nil {
				_ = os.Symlink(p, filepath.Join(cleanBin, tool))
			}
		}

		chaosWget := "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then\n  printf 'BusyBox v1.23.2 multi-call binary.\\n\\nUsage: wget [-q] [-O FILE] [--header ...] URL...\\n\\nRetrieve files via HTTP or FTP\\n'\n  exit 0\nfi\nexit 1\n"
		opensslStub := "#!/bin/sh\nexit 0\n"
		if err := os.WriteFile(filepath.Join(binDir, "wget"), []byte(chaosWget), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(binDir, "openssl"), []byte(opensslStub), 0755); err != nil {
			t.Fatal(err)
		}

		cmd := osexec.Command("sh", "-c", `. "$1" && probe_http_client && printf '%s' "$HTTP_CLIENT"`, "sh", libPath)
		cmd.Env = []string{"PATH=" + binDir + ":" + cleanBin}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("probe_http_client failed: %v\n%s", err, string(out))
		}
		if got := string(out); got != "openssl" {
			t.Fatalf("expected probe_http_client to select openssl, got %q", got)
		}
	})

	t.Run("cslite-agent.init select_prog falls back to /etc/cslite-agent and /data/cslite-agent", func(t *testing.T) {
		initRaw, err := os.ReadFile(filepath.Join("openwrt", "cslite-agent.init"))
		if err != nil {
			t.Fatalf("read cslite-agent.init: %v", err)
		}
		lines := strings.SplitN(string(initRaw), "\n", 2)
		if len(lines) < 2 {
			t.Fatalf("unexpected cslite-agent.init format")
		}
		initLib := filepath.Join(t.TempDir(), "init-lib.sh")
		if err := os.WriteFile(initLib, []byte(lines[1]), 0644); err != nil {
			t.Fatal(err)
		}

		rootDir := t.TempDir()
		etcLite := filepath.Join(rootDir, "etc", "cslite-agent", "cslite-agent-lite")
		dataLite := filepath.Join(rootDir, "data", "cslite-agent", "cslite-agent-lite")
		if err := os.MkdirAll(filepath.Dir(etcLite), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Dir(dataLite), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dataLite, []byte("#!/bin/sh\n"), 0755); err != nil {
			t.Fatal(err)
		}

		runSelect := func() string {
			cmd := osexec.Command("sh", "-c", `. "$1" && select_prog`, "sh", initLib)
			cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "CSLITE_ROOT_PREFIX=" + rootDir}
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("select_prog failed: %v\n%s", err, string(out))
			}
			return string(out)
		}

		if got := runSelect(); got != dataLite {
			t.Fatalf("expected %q when only /data lite exists, got %q", dataLite, got)
		}

		if err := os.WriteFile(etcLite, []byte("#!/bin/sh\n"), 0755); err != nil {
			t.Fatal(err)
		}
		if got := runSelect(); got != etcLite {
			t.Fatalf("expected %q when /usr/bin absent and /etc lite exists, got %q", etcLite, got)
		}

		etcFull := filepath.Join(rootDir, "etc", "cslite-agent", "cslite-agent")
		if err := os.WriteFile(etcFull, []byte("#!/bin/sh\n"), 0755); err != nil {
			t.Fatal(err)
		}
		if got := runSelect(); got != etcFull {
			t.Fatalf("expected %q to take precedence over lite, got %q", etcFull, got)
		}
	})

	t.Run("install.sh is_writable_dir detects read-only directories and probe_downloader prefers openssl", func(t *testing.T) {
		installLib := extractInstallLibrary(t)
		tmpDir := t.TempDir()
		roDir := filepath.Join(tmpDir, "ro")
		rwDir := filepath.Join(tmpDir, "rw")
		_ = os.MkdirAll(roDir, 0555)
		_ = os.MkdirAll(rwDir, 0755)
		defer func() { _ = os.Chmod(roDir, 0755) }()

		if os.Geteuid() != 0 {
			cmd := osexec.Command("sh", "-c", `. "$1" && ! is_writable_dir "$2" && is_writable_dir "$3"`, "sh", installLib, roDir, rwDir)
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("is_writable_dir check failed: %v\n%s", err, string(out))
			}
		}

		binDir := filepath.Join(tmpDir, "bin")
		_ = os.MkdirAll(binDir, 0755)
		for _, tool := range []string{"cat", "tr", "sed", "awk", "mkdir", "rm", "dirname", "dd"} {
			if p, lookErr := osexec.LookPath(tool); lookErr == nil {
				_ = os.Symlink(p, filepath.Join(binDir, tool))
			}
		}
		chaosWget := "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then\n  printf 'BusyBox v1.23.2\\nUsage: wget [-q] [-O FILE] URL\\nRetrieve files via HTTP or FTP\\n'\n  exit 0\nfi\nexit 1\n"
		_ = os.WriteFile(filepath.Join(binDir, "wget"), []byte(chaosWget), 0755)
		_ = os.WriteFile(filepath.Join(binDir, "openssl"), []byte("#!/bin/sh\nexit 0\n"), 0755)

		dlCmd := osexec.Command("sh", "-c", `. "$1" && probe_downloader`, "sh", installLib)
		dlCmd.Env = []string{"PATH=" + binDir}
		dlOut, err := dlCmd.CombinedOutput()
		if err != nil {
			t.Fatalf("probe_downloader failed: %v\n%s", err, string(dlOut))
		}
		if got := string(dlOut); got != filepath.Join(binDir, "openssl") {
			t.Fatalf("expected probe_downloader to select %q, got %q", filepath.Join(binDir, "openssl"), got)
		}
	})

	t.Run("openssl TLS transport E2E for cslite-agent-lite and install.sh", func(t *testing.T) {
		opensslBin, err := osexec.LookPath("openssl")
		if err != nil {
			t.Skip("openssl required for TLS s_client E2E test")
		}

		liteScript, err := filepath.Abs(filepath.Join("openwrt", "cslite-agent-lite.sh"))
		if err != nil {
			t.Fatal(err)
		}
		liteBytes, err := os.ReadFile(liteScript)
		if err != nil {
			t.Fatal(err)
		}
		installBytes, err := os.ReadFile(filepath.Join("scripts", "install.sh"))
		if err != nil {
			t.Fatal(err)
		}

		var regCount, hbCount, pollCount, resCount, redirCount atomic.Int32
		var gotAuthHeader atomic.Value
		var gotResultOutput atomic.Value

		tlsSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/bad-bin":
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte("not found"))
			case "/redir-lite":
				redirCount.Add(1)
				w.Header().Set("Location", "/agent-lite.sh")
				w.WriteHeader(http.StatusFound)
			case "/agent-lite.sh":
				w.Header().Set("Content-Type", "text/plain; charset=utf-8")
				// Send as multi-chunk Transfer-Encoding: chunked to verify POSIX awk chunk decoder.
				half := len(liteBytes) / 2
				_, _ = w.Write(liteBytes[:half])
				if fl, ok := w.(http.Flusher); ok {
					fl.Flush()
				}
				_, _ = w.Write(liteBytes[half:])
			case "/api/agent/register":
				if k := r.Header.Get("X-API-Key"); k != "" {
					gotAuthHeader.Store(k)
				}
				raw, _ := io.ReadAll(r.Body)
				var body map[string]any
				_ = json.Unmarshal(raw, &body)
				if body["api_key"] != "ak_tls_test" {
					t.Errorf("unexpected register body: %s", string(raw))
				}
				regCount.Add(1)
				w.Header().Set("Content-Type", "application/json")
				part1 := `{"code":20000,"data":{"agent_id":"ag_tls_1",`
				part2 := `"device_id":"dev_tls_1"}}`
				_, _ = w.Write([]byte(part1))
				if fl, ok := w.(http.Flusher); ok {
					fl.Flush()
				}
				_, _ = w.Write([]byte(part2))
			case "/api/agent/heartbeat":
				raw, _ := io.ReadAll(r.Body)
				var body map[string]any
				_ = json.Unmarshal(raw, &body)
				if body["agent_id"] == "ag_tls_stale" {
					w.WriteHeader(http.StatusNotFound)
					_, _ = w.Write([]byte(`{"code":40010,"message":"device not found"}`))
					return
				}
				hbCount.Add(1)
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 20000, "data": map[string]any{"status": "ok"}})
			case "/api/agent/commands":
				pollCount.Add(1)
				if r.Header.Get("X-API-Key") != "ak_tls_test" {
					t.Errorf("GET poll missing X-API-Key header: %q", r.Header.Get("X-API-Key"))
				}
				w.Header().Set("Content-Type", "application/json")
				p1 := `{"code":20000,"data":{"commands":[{"result_id":"res_tls_1","command_id":"cmd_tls_1",`
				p2 := `"execution_id":"exec_tls_1","content":"printf tls_ok","timeout":5}]}}`
				_, _ = w.Write([]byte(p1))
				if fl, ok := w.(http.Flusher); ok {
					fl.Flush()
				}
				_, _ = w.Write([]byte(p2))
			case "/api/agent/result":
				raw, _ := io.ReadAll(r.Body)
				var body map[string]any
				_ = json.Unmarshal(raw, &body)
				if outStr, ok := body["output"].(string); ok {
					gotResultOutput.Store(outStr)
				}
				resCount.Add(1)
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 20000, "data": map[string]any{"status": "received", "logged": true}})
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		}))
		defer tlsSrv.Close()

		tmpDir := t.TempDir()
		binDir := filepath.Join(tmpDir, "bin")
		installDir := filepath.Join(tmpDir, "inst")
		cfgDir := filepath.Join(tmpDir, "cfg")
		_ = os.MkdirAll(binDir, 0755)
		for _, tool := range []string{"sh", "cat", "cp", "mv", "rm", "chmod", "mkdir", "dirname", "sed", "tr", "awk", "dd", "od", "wc", "uname", "id", "date", "head", "sleep"} {
			if p, lookErr := osexec.LookPath(tool); lookErr == nil {
				_ = os.Symlink(p, filepath.Join(binDir, tool))
			}
		}
		_ = os.Symlink(opensslBin, filepath.Join(binDir, "openssl"))
		// BusyBox-style HTTP-only wget to ensure install.sh skips it and uses openssl.
		chaosWget := "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then\n  printf 'BusyBox v1.23.2\\nUsage: wget [-q] [-O FILE] URL\\nRetrieve files via HTTP or FTP\\n'\n  exit 0\nfi\nexit 1\n"
		_ = os.WriteFile(filepath.Join(binDir, "wget"), []byte(chaosWget), 0755)

		// Exercise install.sh -> openssl_fetch (404 bad-bin fallback -> 302 redirect -> chunked agent-lite.sh).
		instCmd := osexec.Command("sh", "-s", "--",
			"--server", tlsSrv.URL,
			"--key", "ak_tls_test",
			"--device-id", "dev_tls_1",
			"--bin-url", tlsSrv.URL+"/bad-bin",
		)
		instCmd.Stdin = bytes.NewReader(installBytes)
		instCmd.Env = []string{
			"PATH=" + binDir,
			"HOME=" + tmpDir,
			"TMPDIR=" + tmpDir,
			"CSLITE_INSTALL_DIR=" + installDir,
			"CSLITE_CONFIG_DIR=" + cfgDir,
			"CSLITE_SKIP_SERVICE_EXEC=1",
		}
		if instOut, err := instCmd.CombinedOutput(); err != nil {
			t.Fatalf("install.sh over openssl TLS failed: %v\n%s", err, string(instOut))
		}

		installedLite := filepath.Join(installDir, "cslite-agent-lite")
		gotLiteBytes, err := os.ReadFile(installedLite)
		if err != nil {
			t.Fatalf("expected installed cslite-agent-lite: %v", err)
		}
		if string(gotLiteBytes) != string(liteBytes) {
			t.Fatalf("chunked openssl_fetch altered script bytes (got %d, want %d)", len(gotLiteBytes), len(liteBytes))
		}

		// Also verify 302 redirect path directly via openssl_fetch.
		installLib := extractInstallLibrary(t)
		redirDest := filepath.Join(tmpDir, "redir-out.sh")
		redirCmd := osexec.Command("sh", "-c", `. "$1" && openssl_fetch "$2" "$3" "$4"`, "sh", installLib, tlsSrv.URL+"/redir-lite", redirDest, opensslBin)
		if out, err := redirCmd.CombinedOutput(); err != nil {
			t.Fatalf("openssl_fetch 302 redirect failed: %v\n%s", err, string(out))
		}
		redirBytes, err := os.ReadFile(redirDest)
		if err != nil || string(redirBytes) != string(liteBytes) || redirCount.Load() != 1 {
			t.Fatalf("redirected download mismatch: err=%v redirCount=%d len=%d", err, redirCount.Load(), len(redirBytes))
		}

		// Seed stale state to exercise 404 -> 40010 re-registration + chunked POST/GET + command execution over openssl s_client.
		staleState, _ := json.Marshal(map[string]string{
			"agent_id":   "ag_tls_stale",
			"device_id":  "dev_tls_1",
			"server_url": tlsSrv.URL + "/api",
		})
		_ = os.WriteFile(filepath.Join(cfgDir, "state.json"), staleState, 0600)

		runCmd := osexec.Command(installedLite, "run", "--config", filepath.Join(cfgDir, "config.json"), "--once")
		runCmd.Env = []string{
			"PATH=" + binDir,
			"HOME=" + tmpDir,
			"TMPDIR=" + tmpDir,
			"CSLITE_CONFIG_DIR=" + cfgDir,
			"CSLITE_HTTP_CLIENT=" + opensslBin,
		}
		runOut, err := runCmd.CombinedOutput()
		if err != nil {
			t.Fatalf("cslite-agent-lite --once over openssl TLS failed: %v\n%s", err, string(runOut))
		}
		if regCount.Load() != 1 || hbCount.Load() != 1 || pollCount.Load() != 1 || resCount.Load() != 1 {
			t.Fatalf("unexpected TLS lifecycle counts reg=%d hb=%d poll=%d res=%d", regCount.Load(), hbCount.Load(), pollCount.Load(), resCount.Load())
		}
		if got, _ := gotAuthHeader.Load().(string); got != "ak_tls_test" {
			t.Fatalf("expected X-API-Key ak_tls_test, got %q", got)
		}
		if got, _ := gotResultOutput.Load().(string); got != "tls_ok" {
			t.Fatalf("expected command output tls_ok, got %q", got)
		}
	})

	t.Run("parse_http_url IPv6/query edge cases and plain HTTP nc + binary download", func(t *testing.T) {
		libPath := extractLiteLibrary(t)
		cases := []struct {
			url  string
			want string
		}{
			{"https://example.com/api/agent/commands?agent_id=1&limit=1", "https|example.com|443|/api/agent/commands?agent_id=1&limit=1|example.com"},
			{"https://[::1]:8443/api", "https|::1|8443|/api|[::1]:8443"},
			{"http://[::1]", "http|::1|80|/|[::1]"},
			{"https://example.com?foo=/bar", "https|example.com|443|/?foo=/bar|example.com"},
		}
		for _, tc := range cases {
			cmd := osexec.Command("sh", "-c", `. "$1" && parse_http_url "$2" && printf '%s|%s|%s|%s|%s' "$URL_SCHEME" "$URL_HOST" "$URL_PORT" "$URL_PATH" "$URL_HOST_HDR"`, "sh", libPath, tc.url)
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("parse_http_url(%q) failed: %v\n%s", tc.url, err, string(out))
			}
			if string(out) != tc.want {
				t.Fatalf("parse_http_url(%q) = %q, want %q", tc.url, string(out), tc.want)
			}
		}

		ncBin, err := osexec.LookPath("nc")
		if err != nil {
			t.Skip("nc required for plain HTTP fallback test")
		}
		opensslBin, err := osexec.LookPath("openssl")
		if err != nil {
			t.Skip("openssl required for openssl_fetch plain HTTP test")
		}

		elfPayload := append([]byte{0x7f, 'E', 'L', 'F', 0x00, 0x01, 0x00, 0x02}, bytes.Repeat([]byte{0x00, 0xaa, 0x55}, 512)...)
		var httpPollCount atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/elf-bin":
				w.Header().Set("Content-Type", "application/octet-stream")
				_, _ = w.Write(elfPayload)
			case "/api/agent/register":
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 20000, "data": map[string]any{"agent_id": "ag_nc_1", "device_id": "dev_nc_1"}})
			case "/api/agent/heartbeat":
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 20000, "data": map[string]any{"status": "ok"}})
			case "/api/agent/commands":
				httpPollCount.Add(1)
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 20000, "data": map[string]any{"commands": []any{}}})
			}
		}))
		defer srv.Close()

		installLib := extractInstallLibrary(t)
		binDest := filepath.Join(t.TempDir(), "elf-out")
		binCmd := osexec.Command("sh", "-c", `. "$1" && openssl_fetch "$2" "$3" "$4"`, "sh", installLib, srv.URL+"/elf-bin", binDest, opensslBin)
		binCmd.Env = []string{"PATH=" + filepath.Dir(ncBin) + ":" + os.Getenv("PATH")}
		if out, err := binCmd.CombinedOutput(); err != nil {
			t.Fatalf("openssl_fetch binary over plain HTTP failed: %v\n%s", err, string(out))
		}
		gotElf, err := os.ReadFile(binDest)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(gotElf, elfPayload) {
			t.Fatalf("binary payload with NUL bytes corrupted: got len=%d want len=%d", len(gotElf), len(elfPayload))
		}

		liteScript, _ := filepath.Abs(filepath.Join("openwrt", "cslite-agent-lite.sh"))
		cfgDir := t.TempDir()
		runCmd := osexec.Command("sh", liteScript, "run", "--server", srv.URL, "--key", "ak_nc_test", "--once")
		runCmd.Env = []string{
			"PATH=" + filepath.Dir(ncBin) + ":" + os.Getenv("PATH"),
			"TMPDIR=" + cfgDir,
			"CSLITE_CONFIG_DIR=" + cfgDir,
			"CSLITE_HTTP_CLIENT=" + opensslBin,
		}
		if out, err := runCmd.CombinedOutput(); err != nil {
			t.Fatalf("lite agent plain HTTP nc fallback failed: %v\n%s", err, string(out))
		}
		if httpPollCount.Load() != 1 {
			t.Fatalf("expected 1 poll over nc, got %d", httpPollCount.Load())
		}
	})
}

func TestLiteShellTwoTierPollWithTelemetry(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell test")
	}

	libPath := extractLiteLibrary(t)
	var muBytes [][]byte
	var methods []string
	var paths []string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		methods = append(methods, r.Method)
		paths = append(paths, r.URL.Path)
		muBytes = append(muBytes, raw)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": 20000,
			"data": map[string]any{
				"commands":       []any{},
				"poll_interval":  15,
				"next_heartbeat": 300,
			},
		})
	}))
	defer srv.Close()

	cfgDir := t.TempDir()
	script := `
. "$1"
SERVER="$2"
API_KEY="ak_lite_test"
AGENT_ID="ag_lite_1"
BOUND_DEVICE_ID="dev_lite_1"
POLL_INTERVAL="5"
HEARTBEAT_INTERVAL="60"
POLL_EXPLICIT=0
HB_EXPLICIT=0
probe_http_client
normalize_server_url "$SERVER"
poll_once 0 || exit 11
SYNC0="$LAST_HB_SYNC"
poll_once 1 || exit 12
printf '%s|%s|%s|%s\n' "$SYNC0" "$LAST_HB_SYNC" "$POLL_INTERVAL" "$HEARTBEAT_INTERVAL"
`
	cmd := osexec.Command("sh", "-c", script, "sh", libPath, srv.URL)
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"TMPDIR=" + cfgDir,
		"CSLITE_CONFIG_DIR=" + cfgDir,
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("poll_once test failed: %v\n%s", err, string(out))
	}

	if len(muBytes) != 2 {
		t.Fatalf("expected 2 poll requests, got %d", len(muBytes))
	}
	for i := range methods {
		if methods[i] != http.MethodPost || paths[i] != "/api/agent/commands" {
			t.Fatalf("request %d = %s %s, want POST /api/agent/commands", i, methods[i], paths[i])
		}
	}

	var lightBody map[string]any
	if err := json.Unmarshal(muBytes[0], &lightBody); err != nil {
		t.Fatalf("invalid lightBody JSON %s: %v", string(muBytes[0]), err)
	}
	if lightBody["agent_id"] != "ag_lite_1" || lightBody["api_key"] != "ak_lite_test" || lightBody["limit"] != float64(1) {
		t.Fatalf("unexpected lightweight poll body: %v", lightBody)
	}
	if _, hasMetrics := lightBody["metrics"]; hasMetrics {
		t.Fatalf("poll_once 0 must not send metrics, got: %s", string(muBytes[0]))
	}

	var telemetryBody map[string]any
	if err := json.Unmarshal(muBytes[1], &telemetryBody); err != nil {
		t.Fatalf("invalid telemetryBody JSON %s: %v", string(muBytes[1]), err)
	}
	if telemetryBody["agent_id"] != "ag_lite_1" || telemetryBody["api_key"] != "ak_lite_test" || telemetryBody["limit"] != float64(1) {
		t.Fatalf("unexpected telemetry poll identifiers: %v", telemetryBody)
	}
	metricsMap, ok := telemetryBody["metrics"].(map[string]any)
	if !ok || len(metricsMap) == 0 {
		t.Fatalf("poll_once 1 must send metrics object, got: %s", string(muBytes[1]))
	}
	for _, key := range []string{"version", "os_version", "hostname", "timestamp"} {
		if s, ok := telemetryBody[key].(string); !ok || s == "" {
			t.Fatalf("poll_once 1 missing non-empty %s in %s", key, string(muBytes[1]))
		}
	}

	parts := strings.Split(strings.TrimSpace(string(out)), "|")
	if len(parts) != 4 {
		t.Fatalf("unexpected output %q", string(out))
	}
	if parts[0] != "0" {
		t.Fatalf("expected LAST_HB_SYNC=0 after poll_once 0, got %q", parts[0])
	}
	if parts[1] == "0" || parts[1] == "" {
		t.Fatalf("expected non-zero LAST_HB_SYNC after poll_once 1, got %q", parts[1])
	}
	if parts[2] != "15" || parts[3] != "300" {
		t.Fatalf("expected server-pushed intervals 15/300, got %s/%s", parts[2], parts[3])
	}
}
