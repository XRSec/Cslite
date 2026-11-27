package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/XRSec/Cslite/agent/internal/protocol"
)

func TestNormalizeServerURL(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"https://example.com", "https://example.com/api", false},
		{"https://example.com/", "https://example.com/api", false},
		{"https://example.com///", "https://example.com/api", false},
		{"https://example.com/api", "https://example.com/api", false},
		{"https://example.com/api/", "https://example.com/api", false},
		{"http://127.0.0.1:8787/prefix", "http://127.0.0.1:8787/prefix/api", false},
		{"http://127.0.0.1:8787/prefix/api/", "http://127.0.0.1:8787/prefix/api", false},
		{"", "", true},
		{"ftp://example.com", "", true},
		{"https://", "", true},
	}

	for _, tc := range cases {
		got, err := NormalizeServerURL(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("NormalizeServerURL(%q) expected error, got %q", tc.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("NormalizeServerURL(%q) unexpected error: %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("NormalizeServerURL(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestDeviceNotFoundErrorParsing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != "ak_live_test" {
			t.Fatalf("missing X-API-Key header: %q", r.Header.Get("X-API-Key"))
		}
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code":    protocol.CodeDeviceNotFound,
			"message": "device not found",
			"data":    nil,
		})
	}))
	defer srv.Close()

	c, err := New(srv.URL, "ak_live_test")
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}

	_, err = c.Heartbeat(context.Background(), protocol.HeartbeatRequest{AgentID: "agent_1"})
	if !IsDeviceNotFound(err) {
		t.Fatalf("expected IsDeviceNotFound(err) == true, got %v", err)
	}
}

func TestReportResultExponentialBackoffRetry(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/result" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		n := attempts.Add(1)
		if n < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code":    protocol.CodeInternalError,
				"message": "temporary error",
				"data":    nil,
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code":    protocol.CodeOK,
			"message": "ok",
			"data": map[string]any{
				"status": "received",
				"logged": true,
			},
		})
	}))
	defer srv.Close()

	c, err := New(srv.URL+"/", "ak_live_test", Options{
		RetryBackoffs: []time.Duration{
			5 * time.Millisecond,
			10 * time.Millisecond,
			20 * time.Millisecond,
		},
	})
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}

	resp, err := c.ReportResult(context.Background(), protocol.ResultRequest{
		ResultID:    "res_1",
		ExecutionID: "exec_1",
		DeviceID:    "dev_1",
		Status:      protocol.StatusCompleted,
		ExitCode:    0,
		Output:      "hello",
	})
	if err != nil {
		t.Fatalf("ReportResult() failed after retries: %v", err)
	}
	if !resp.Logged || resp.Status != "received" {
		t.Fatalf("unexpected ReportResult response: %+v", resp)
	}
	if got := attempts.Load(); got != 3 {
		t.Fatalf("attempts = %d, want 3", got)
	}
}

func TestPollCommandsQueryParams(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/commands" {
			t.Fatalf("path = %s, want /api/agent/commands", r.URL.Path)
		}
		if r.URL.Query().Get("agent_id") != "ag_1" || r.URL.Query().Get("limit") != "3" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code":    protocol.CodeOK,
			"message": "ok",
			"data": map[string]any{
				"commands": []map[string]any{
					{
						"result_id":    "res_1",
						"command_id":   "cmd_1",
						"execution_id": "exec_1",
						"type":         "immediate",
						"content":      "echo ok",
						"timeout":      30,
					},
				},
			},
		})
	}))
	defer srv.Close()

	c, err := New(srv.URL+"/api/", "ak_live_test")
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}
	cmds, err := c.PollCommands(context.Background(), "ag_1", 3)
	if err != nil {
		t.Fatalf("PollCommands() failed: %v", err)
	}
	if len(cmds) != 1 || cmds[0].ResultID != "res_1" {
		t.Fatalf("unexpected commands: %+v", cmds)
	}
}

func TestPollCommandsWithStatus(t *testing.T) {
	var seen []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/api/agent/commands" {
			t.Fatalf("path = %s, want /api/agent/commands", r.URL.Path)
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		seen = append(seen, payload)

		_ = json.NewEncoder(w).Encode(map[string]any{
			"code":    protocol.CodeOK,
			"message": "ok",
			"data": map[string]any{
				"poll_interval":  15,
				"next_heartbeat": 300,
				"commands": []map[string]any{
					{
						"result_id":    "res_post_1",
						"command_id":   "cmd_post_1",
						"execution_id": "exec_post_1",
						"type":         "immediate",
						"content":      "uname -a",
						"timeout":      30,
					},
				},
			},
		})
	}))
	defer srv.Close()

	c, err := New(srv.URL, "ak_live_test")
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}

	lightResp, err := c.PollCommandsWithStatus(context.Background(), protocol.PollCommandsRequest{
		AgentID: "ag_1",
		Limit:   2,
	})
	if err != nil {
		t.Fatalf("lightweight PollCommandsWithStatus failed: %v", err)
	}
	if lightResp.PollInterval != 15 || lightResp.NextHeartbeat != 300 || len(lightResp.Commands) != 1 {
		t.Fatalf("unexpected lightResp: %+v", lightResp)
	}
	if _, hasMetrics := seen[0]["metrics"]; hasMetrics {
		t.Fatalf("expected lightweight poll to omit metrics, got %v", seen[0])
	}

	telResp, err := c.PollCommandsWithStatus(context.Background(), protocol.PollCommandsRequest{
		AgentID:   "ag_1",
		Limit:     4,
		Version:   "v1.2.3",
		OSVersion: "Ubuntu 24.04",
		Hostname:  "node-01",
		Timestamp: "2026-11-27T09:00:00Z",
		Metrics: &protocol.DeviceMetrics{
			CPUUsage:   23.5,
			MemoryUsed: 256,
			DiskUsage:  40.0,
			NetworkIn:  10,
			NetworkOut: 20,
		},
	})
	if err != nil {
		t.Fatalf("telemetry PollCommandsWithStatus failed: %v", err)
	}
	if telResp.PollInterval != 15 || telResp.NextHeartbeat != 300 || len(telResp.Commands) != 1 {
		t.Fatalf("unexpected telResp: %+v", telResp)
	}
	if _, hasMetrics := seen[1]["metrics"]; !hasMetrics {
		t.Fatalf("expected telemetry poll to include metrics, got %v", seen[1])
	}
	if seen[1]["version"] != "v1.2.3" || seen[1]["hostname"] != "node-01" || seen[1]["os_version"] != "Ubuntu 24.04" {
		t.Fatalf("unexpected telemetry metadata: %v", seen[1])
	}
}

func TestDefaultAndOverrideHeaders(t *testing.T) {
	var gotUA, gotRef string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Get("User-Agent")
		gotRef = r.Header.Get("Referer")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code":    protocol.CodeOK,
			"message": "ok",
			"data":    map[string]any{"status": "ok"},
		})
	}))
	defer srv.Close()

	defClient, err := New(srv.URL, "ak_live_hdr")
	if err != nil {
		t.Fatalf("New(default) failed: %v", err)
	}
	if _, err := defClient.Heartbeat(context.Background(), protocol.HeartbeatRequest{AgentID: "ag_hdr"}); err != nil {
		t.Fatalf("Heartbeat(default) failed: %v", err)
	}
	if gotUA != "CSLite-Agent/1.0" {
		t.Fatalf("default User-Agent = %q, want %q", gotUA, "CSLite-Agent/1.0")
	}
	if gotRef != srv.URL+"/agent/telemetry" {
		t.Fatalf("default Referer = %q, want %q", gotRef, srv.URL+"/agent/telemetry")
	}

	customClient, err := New(srv.URL+"/api", "ak_live_hdr", Options{
		UserAgent: "CSLite-Agent/v1.1.0",
		Referer:   "https://ctrl.example.com/custom-ref",
	})
	if err != nil {
		t.Fatalf("New(custom) failed: %v", err)
	}
	if _, err := customClient.Heartbeat(context.Background(), protocol.HeartbeatRequest{AgentID: "ag_hdr"}); err != nil {
		t.Fatalf("Heartbeat(custom) failed: %v", err)
	}
	if gotUA != "CSLite-Agent/v1.1.0" {
		t.Fatalf("custom User-Agent = %q, want %q", gotUA, "CSLite-Agent/v1.1.0")
	}
	if gotRef != "https://ctrl.example.com/custom-ref" {
		t.Fatalf("custom Referer = %q, want %q", gotRef, "https://ctrl.example.com/custom-ref")
	}
}
