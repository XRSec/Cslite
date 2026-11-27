// Package client implements the Cslite /api/agent/* HTTP protocol client.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/XRSec/Cslite/agent/internal/protocol"
)

const maxResponseBytes = 4 << 20 // 4 MiB safety limit

var defaultBackoffs = []time.Duration{
	500 * time.Millisecond,
	1 * time.Second,
	2 * time.Second,
	4 * time.Second,
}

// APIError represents an application-level or HTTP error returned by the Cslite server.
type APIError struct {
	HTTPStatus int
	Code       int
	Message    string
}

func (e *APIError) Error() string {
	if e.Code != 0 {
		return fmt.Sprintf("api error (http=%d code=%d): %s", e.HTTPStatus, e.Code, e.Message)
	}
	return fmt.Sprintf("http error (%d): %s", e.HTTPStatus, e.Message)
}

// IsDeviceNotFound returns true if the server reported DEVICE_NOT_FOUND (40010).
func (e *APIError) IsDeviceNotFound() bool {
	return e.Code == protocol.CodeDeviceNotFound
}

// IsDeviceNotFound reports whether err represents DEVICE_NOT_FOUND (40010).
func IsDeviceNotFound(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.IsDeviceNotFound()
}

// Options customizes HTTP client behavior.
type Options struct {
	HTTPClient    *http.Client
	UserAgent     string
	RetryBackoffs []time.Duration
}

// Client communicates with a Cslite server's /api/agent/* endpoints.
type Client struct {
	baseURL       string
	apiKey        string
	httpClient    *http.Client
	userAgent     string
	retryBackoffs []time.Duration
}

// NormalizeServerURL strips trailing slashes and appends /api unless already present.
func NormalizeServerURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", errors.New("server URL is empty")
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("invalid server URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("unsupported server URL scheme %q: expected http or https", u.Scheme)
	}
	if u.Host == "" {
		return "", errors.New("server URL missing host")
	}

	p := strings.TrimRight(u.Path, "/")
	if p != "/api" && !strings.HasSuffix(p, "/api") {
		p += "/api"
	}
	u.Path = p
	u.RawQuery = ""
	u.Fragment = ""
	return strings.TrimRight(u.String(), "/"), nil
}

// New constructs a Client with normalized server URL and default HTTP/retry settings.
func New(serverURL, apiKey string, opts ...Options) (*Client, error) {
	normalized, err := NormalizeServerURL(serverURL)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("api_key is required")
	}

	var opt Options
	if len(opts) > 0 {
		opt = opts[0]
	}
	hc := opt.HTTPClient
	if hc == nil {
		hc = &http.Client{
			Timeout: 30 * time.Second,
		}
	}
	ua := opt.UserAgent
	if ua == "" {
		ua = "cslite-agent/1.0"
	}
	backoffs := defaultBackoffs
	if opt.RetryBackoffs != nil {
		backoffs = opt.RetryBackoffs
	}

	return &Client{
		baseURL:       normalized,
		apiKey:        strings.TrimSpace(apiKey),
		httpClient:    hc,
		userAgent:     ua,
		retryBackoffs: backoffs,
	}, nil
}

// BaseURL returns the normalized /api base URL.
func (c *Client) BaseURL() string {
	return c.baseURL
}

// Register calls POST /api/agent/register.
func (c *Client) Register(ctx context.Context, req protocol.RegisterRequest) (*protocol.RegisterResponse, error) {
	var out protocol.RegisterResponse
	if err := c.doJSON(ctx, http.MethodPost, "/agent/register", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Heartbeat calls POST /api/agent/heartbeat.
func (c *Client) Heartbeat(ctx context.Context, req protocol.HeartbeatRequest) (*protocol.HeartbeatResponse, error) {
	var out protocol.HeartbeatResponse
	if err := c.doJSON(ctx, http.MethodPost, "/agent/heartbeat", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// PollCommands calls GET /api/agent/commands.
func (c *Client) PollCommands(ctx context.Context, agentID string, limit int) ([]protocol.CommandTask, error) {
	q := url.Values{}
	q.Set("agent_id", agentID)
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	path := "/agent/commands?" + q.Encode()

	var out protocol.PollCommandsResponse
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out.Commands, nil
}

// PollCommandsWithStatus calls POST /api/agent/commands, optionally carrying host telemetry.
func (c *Client) PollCommandsWithStatus(ctx context.Context, req protocol.PollCommandsRequest) (*protocol.PollCommandsResponse, error) {
	var out protocol.PollCommandsResponse
	if err := c.doJSON(ctx, http.MethodPost, "/agent/commands", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ReportResult calls POST /api/agent/result with exponential backoff on transient failures.
func (c *Client) ReportResult(ctx context.Context, req protocol.ResultRequest) (*protocol.ResultResponse, error) {
	var out protocol.ResultResponse
	var lastErr error

	attempts := len(c.retryBackoffs) + 1
	for i := 0; i < attempts; i++ {
		err := c.doJSON(ctx, http.MethodPost, "/agent/result", req, &out)
		if err == nil {
			return &out, nil
		}
		lastErr = err
		if !isRetryable(err) {
			return nil, err
		}
		if i >= len(c.retryBackoffs) {
			break
		}
		wait := c.retryBackoffs[i]
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	return nil, lastErr
}

func isRetryable(err error) bool {
	if errors.Is(err, context.Canceled) {
		return false
	}
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		// Retry server/rate-limit errors; fail fast on deterministic 4xx business errors.
		if apiErr.HTTPStatus == http.StatusTooManyRequests || apiErr.HTTPStatus >= 500 || apiErr.HTTPStatus == 0 {
			return apiErr.Code == 0 || apiErr.Code == protocol.CodeInternalError
		}
		return false
	}
	return true
}

func (c *Client) doJSON(ctx context.Context, method, path string, reqBody any, dst any) error {
	var bodyReader io.Reader
	if reqBody != nil {
		payload, err := json.Marshal(reqBody)
		if err != nil {
			return fmt.Errorf("marshal request: %w", err)
		}
		bodyReader = bytes.NewReader(payload)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bodyReader)
	if err != nil {
		return err
	}
	req.Header.Set("X-API-Key", c.apiKey)
	req.Header.Set("User-Agent", c.userAgent)
	req.Header.Set("Accept", "application/json")
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}

	var env protocol.Envelope[json.RawMessage]
	if err := json.Unmarshal(raw, &env); err == nil && (env.Code != 0 || env.Message != "") {
		if env.Code != protocol.CodeOK {
			return &APIError{
				HTTPStatus: resp.StatusCode,
				Code:       env.Code,
				Message:    env.Message,
			}
		}
		if dst != nil && len(env.Data) > 0 && string(env.Data) != "null" {
			if err := json.Unmarshal(env.Data, dst); err != nil {
				return fmt.Errorf("decode response data: %w", err)
			}
		}
		return nil
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := strings.TrimSpace(string(raw))
		if msg == "" {
			msg = http.StatusText(resp.StatusCode)
		}
		return &APIError{
			HTTPStatus: resp.StatusCode,
			Message:    msg,
		}
	}

	return fmt.Errorf("unexpected response body from %s: %s", path, strings.TrimSpace(string(raw)))
}
