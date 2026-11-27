package core

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/XRSec/Cslite/agent/internal/client"
	"github.com/XRSec/Cslite/agent/internal/config"
	"github.com/XRSec/Cslite/agent/internal/exec"
	"github.com/XRSec/Cslite/agent/internal/protocol"
	"github.com/XRSec/Cslite/agent/internal/state"
)

func TestAgentAutoReRegisterOn40010AndDeduplicate(t *testing.T) {
	var regCount atomic.Int32
	var hbCount atomic.Int32
	var execCount atomic.Int32
	var mu sync.Mutex
	var reported []protocol.ResultRequest

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agent/register":
			regCount.Add(1)
			agentID := "agent_2"
			deviceID := "dev_2"
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code":    protocol.CodeOK,
				"message": "ok",
				"data": map[string]any{
					"agent_id":           agentID,
					"device_id":          deviceID,
					"heartbeat_interval": 60,
					"poll_interval":      1,
				},
			})

		case "/api/agent/heartbeat":
			var req protocol.HeartbeatRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			hbCount.Add(1)
			if req.AgentID == "agent_1" {
				w.WriteHeader(http.StatusNotFound)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"code":    protocol.CodeDeviceNotFound,
					"message": "device not found",
					"data":    nil,
				})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code":    protocol.CodeOK,
				"message": "ok",
				"data": map[string]any{
					"status":         "ok",
					"next_heartbeat": 60,
					"poll_interval":  1,
				},
			})

		case "/api/agent/commands":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code":    protocol.CodeOK,
				"message": "ok",
				"data": map[string]any{
					"commands": []map[string]any{
						{
							"result_id":    "res_dup",
							"command_id":   "cmd_1",
							"execution_id": "exec_1",
							"type":         "immediate",
							"content":      "echo hi",
							"timeout":      10,
						},
						{
							"result_id":    "res_dup",
							"command_id":   "cmd_1",
							"execution_id": "exec_1",
							"type":         "immediate",
							"content":      "echo hi",
							"timeout":      10,
						},
					},
				},
			})

		case "/api/agent/result":
			var req protocol.ResultRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			mu.Lock()
			reported = append(reported, req)
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code":    protocol.CodeOK,
				"message": "ok",
				"data": map[string]any{
					"status": "received",
					"logged": true,
				},
			})
		}
	}))
	defer srv.Close()

	statePath := filepath.Join(t.TempDir(), "state.json")
	if err := state.Save(statePath, &state.State{
		AgentID:   "agent_1",
		DeviceID:  "dev_1",
		ServerURL: srv.URL + "/api",
	}); err != nil {
		t.Fatalf("seed state failed: %v", err)
	}

	cfg := &config.Config{
		Server:            srv.URL,
		APIKey:            "ak_live_test",
		PollInterval:      1,
		HeartbeatInterval: 60,
		StatePath:         statePath,
	}

	ag, err := New(cfg, Options{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		ClientOpts: []client.Options{{
			RetryBackoffs: []time.Duration{5 * time.Millisecond},
		}},
		ExecFunc: func(_ context.Context, _ exec.Request) exec.Result {
			execCount.Add(1)
			return exec.Result{Status: protocol.StatusCompleted, ExitCode: 0, Output: "hi"}
		},
	})
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}

	if err := ag.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce() failed: %v", err)
	}

	if regCount.Load() != 1 {
		t.Fatalf("expected 1 re-register call on 40010, got %d", regCount.Load())
	}
	if hbCount.Load() != 2 {
		t.Fatalf("expected 2 heartbeat attempts (40010 then ok), got %d", hbCount.Load())
	}
	if execCount.Load() != 1 {
		t.Fatalf("expected duplicate task to execute only once, got %d", execCount.Load())
	}

	mu.Lock()
	defer mu.Unlock()
	if len(reported) != 1 || reported[0].DeviceID != "dev_2" || reported[0].ResultID != "res_dup" {
		t.Fatalf("unexpected reported results: %+v", reported)
	}
}

func TestAgentCleanRunAndShutdown(t *testing.T) {
	var hbCount atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agent/register":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code":    protocol.CodeOK,
				"message": "ok",
				"data": map[string]any{
					"agent_id":           "agent_clean",
					"device_id":          "dev_clean",
					"heartbeat_interval": 60,
					"poll_interval":      1,
				},
			})
		case "/api/agent/heartbeat":
			hbCount.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code":    protocol.CodeOK,
				"message": "ok",
				"data": map[string]any{
					"status":         "ok",
					"next_heartbeat": 60,
					"poll_interval":  1,
				},
			})
		case "/api/agent/commands":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code":    protocol.CodeOK,
				"message": "ok",
				"data":    map[string]any{"commands": []any{}},
			})
		}
	}))
	defer srv.Close()

	cfg := &config.Config{
		Server:            srv.URL,
		APIKey:            "ak_live_test",
		PollInterval:      1,
		HeartbeatInterval: 60,
		StatePath:         filepath.Join(t.TempDir(), "state.json"),
	}
	ag, err := New(cfg, Options{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- ag.Run(ctx)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for hbCount.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if hbCount.Load() == 0 {
		cancel()
		t.Fatalf("expected immediate startup heartbeat")
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() returned unexpected error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Run() did not shut down cleanly within 2s")
	}
}

func TestAgentTwoTierPollWithTelemetryAndSuppressesHeartbeat(t *testing.T) {
	var hbCount atomic.Int32
	var lightPolls atomic.Int32
	var telemetryPolls atomic.Int32
	var methodErr atomic.Value

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agent/register":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code":    protocol.CodeOK,
				"message": "ok",
				"data": map[string]any{
					"agent_id":           "agent_tier",
					"device_id":          "dev_tier",
					"heartbeat_interval": 300,
					"poll_interval":      15,
				},
			})
		case "/api/agent/heartbeat":
			hbCount.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code":    protocol.CodeOK,
				"message": "ok",
				"data": map[string]any{
					"status":         "ok",
					"next_heartbeat": 300,
					"poll_interval":  15,
				},
			})
		case "/api/agent/commands":
			if r.Method != http.MethodPost {
				methodErr.Store("expected POST /api/agent/commands, got " + r.Method)
			}
			var req protocol.PollCommandsRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			if req.Metrics != nil {
				if req.Version == "" || req.Timestamp == "" {
					methodErr.Store("telemetry poll missing version or timestamp")
				}
				telemetryPolls.Add(1)
			} else {
				lightPolls.Add(1)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code":    protocol.CodeOK,
				"message": "ok",
				"data": map[string]any{
					"commands":       []any{},
					"poll_interval":  15,
					"next_heartbeat": 300,
				},
			})
		}
	}))
	defer srv.Close()

	// Verify pollWithRecovery applies server-pushed intervals when not explicitly locked.
	dynCfg := &config.Config{
		Server:            srv.URL,
		APIKey:            "ak_live_test",
		PollInterval:      5,
		HeartbeatInterval: 60,
		StatePath:         filepath.Join(t.TempDir(), "dyn-state.json"),
	}
	dynAg, err := New(dynCfg, Options{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("New(dynCfg) failed: %v", err)
	}
	dynAg.setIdentity("agent_tier", "dev_tier")
	if _, err := dynAg.pollWithRecovery(context.Background(), "agent_tier", 1); err != nil {
		t.Fatalf("dynAg.pollWithRecovery failed: %v", err)
	}
	if dynAg.getPollInterval() != 15*time.Second || dynAg.getHeartbeatInterval() != 300*time.Second {
		t.Fatalf("expected server-pushed intervals 15s/300s, got %v/%v", dynAg.getPollInterval(), dynAg.getHeartbeatInterval())
	}

	// Verify steady daemon polling suppresses duplicate /api/agent/heartbeat requests.
	cfg := &config.Config{
		Server:            srv.URL,
		APIKey:            "ak_live_test",
		PollInterval:      1,
		HeartbeatInterval: 1,
		ExplicitPoll:      true,
		ExplicitHeartbeat: true,
		StatePath:         filepath.Join(t.TempDir(), "state.json"),
	}
	ag, err := New(cfg, Options{
		Version: "v2.0.0",
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}
	ag.intervalMu.Lock()
	ag.pollInterval = 25 * time.Millisecond
	ag.heartbeatInterval = 80 * time.Millisecond
	ag.intervalMu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- ag.Run(ctx)
	}()

	deadline := time.Now().Add(3 * time.Second)
	for (lightPolls.Load() < 1 || telemetryPolls.Load() < 2) && time.Now().Before(deadline) {
		time.Sleep(15 * time.Millisecond)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Run() did not shut down cleanly")
	}

	if msg, ok := methodErr.Load().(string); ok && msg != "" {
		t.Fatal(msg)
	}
	if lightPolls.Load() < 1 {
		t.Fatalf("expected >= 1 lightweight poll without metrics, got %d", lightPolls.Load())
	}
	if telemetryPolls.Load() < 2 {
		t.Fatalf("expected >= 2 periodic telemetry polls with metrics, got %d", telemetryPolls.Load())
	}
	if got := hbCount.Load(); got != 1 {
		t.Fatalf("expected only 1 startup /api/agent/heartbeat (steady polling must suppress duplicates), got %d", got)
	}
}
