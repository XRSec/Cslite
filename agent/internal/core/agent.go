// Package core orchestrates agent registration, heartbeats, adaptive polling, and worker execution.
package core

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/XRSec/Cslite/agent/internal/client"
	"github.com/XRSec/Cslite/agent/internal/config"
	"github.com/XRSec/Cslite/agent/internal/exec"
	"github.com/XRSec/Cslite/agent/internal/metrics"
	"github.com/XRSec/Cslite/agent/internal/protocol"
	"github.com/XRSec/Cslite/agent/internal/state"
)

const (
	defaultMaxWorkers = 4
	fastPollInterval  = 1 * time.Second
	fastPollBurst     = 15 * time.Second
)

// Options configures optional runtime behaviors of the Agent.
type Options struct {
	Version    string
	MaxWorkers int
	Logger     *slog.Logger
	ClientOpts []client.Options
	ExecFunc   func(ctx context.Context, req exec.Request) exec.Result
}

// Agent runs the registration, heartbeat, command polling, and execution loops.
type Agent struct {
	cfg       *config.Config
	client    *client.Client
	collector *metrics.Collector
	platform  metrics.PlatformInfo
	logger    *slog.Logger
	version   string
	execFn    func(ctx context.Context, req exec.Request) exec.Result

	maxWorkers int

	idMu     sync.RWMutex
	regMu    sync.Mutex
	agentID  string
	deviceID string

	intervalMu        sync.RWMutex
	pollInterval      time.Duration
	heartbeatInterval time.Duration

	flightMu sync.Mutex
	inFlight map[string]struct{}

	fastMu        sync.Mutex
	fastPollUntil time.Time
	pollWakeCh    chan struct{}

	// Lock order: metricsSyncMu -> regMu -> idMu / intervalMu.
	metricsSyncMu     sync.Mutex
	lastMetricsSyncNs atomic.Int64
}

// New constructs an Agent ready to run.
func New(cfg *config.Config, opts ...Options) (*Agent, error) {
	if cfg == nil {
		return nil, errors.New("config is required")
	}
	var opt Options
	if len(opts) > 0 {
		opt = opts[0]
	}

	version := opt.Version
	if version == "" {
		version = "v1.2.0"
	}
	maxWorkers := opt.MaxWorkers
	if maxWorkers <= 0 {
		maxWorkers = defaultMaxWorkers
	}
	logger := opt.Logger
	if logger == nil {
		logger = slog.Default()
	}
	execFn := opt.ExecFunc
	if execFn == nil {
		execFn = exec.Execute
	}

	clientOpts := opt.ClientOpts
	if len(clientOpts) == 0 {
		ua := strings.TrimSpace(cfg.UserAgent)
		if ua == "" {
			ua = client.DefaultUserAgent(version)
		}
		clientOpts = []client.Options{{
			UserAgent: ua,
			Referer:   strings.TrimSpace(cfg.Referer),
		}}
	}
	c, err := client.New(cfg.Server, cfg.APIKey, clientOpts...)
	if err != nil {
		return nil, err
	}

	pollInt := time.Duration(cfg.PollInterval) * time.Second
	if pollInt <= 0 {
		pollInt = config.DefaultPollInterval * time.Second
	}
	hbInt := time.Duration(cfg.HeartbeatInterval) * time.Second
	if hbInt <= 0 {
		hbInt = config.DefaultHeartbeatInterval * time.Second
	}

	return &Agent{
		cfg:               cfg,
		client:            c,
		collector:         metrics.NewCollector(),
		platform:          metrics.DetectPlatform(),
		logger:            logger,
		version:           version,
		execFn:            execFn,
		maxWorkers:        maxWorkers,
		pollInterval:      pollInt,
		heartbeatInterval: hbInt,
		inFlight:          make(map[string]struct{}),
		pollWakeCh:        make(chan struct{}, 1),
	}, nil
}

// Run starts the agent and blocks until ctx is cancelled and all goroutines exit cleanly.
func (a *Agent) Run(ctx context.Context) error {
	if err := a.ensureRegisteredWithRetry(ctx); err != nil {
		return err
	}

	// Send initial heartbeat immediately on startup.
	if err := a.sendHeartbeat(ctx); err != nil {
		a.logger.Warn("initial heartbeat failed", "err", err)
	}

	taskCh := make(chan protocol.CommandTask, a.maxWorkers)
	var wg sync.WaitGroup

	for i := 0; i < a.maxWorkers; i++ {
		wg.Add(1)
		go a.workerLoop(ctx, &wg, taskCh)
	}

	wg.Add(1)
	go a.heartbeatLoop(ctx, &wg)

	wg.Add(1)
	go a.pollLoop(ctx, &wg, taskCh)

	<-ctx.Done()
	wg.Wait()
	return nil
}

// RunOnce executes a single register -> heartbeat -> poll -> execute cycle cleanly.
func (a *Agent) RunOnce(ctx context.Context) error {
	if err := a.ensureRegistered(ctx); err != nil {
		return err
	}
	if err := a.sendHeartbeat(ctx); err != nil {
		return err
	}

	agentID, _ := a.identity()
	tasks, err := a.pollWithRecovery(ctx, agentID, a.maxWorkers)
	if err != nil {
		return err
	}
	if len(tasks) == 0 {
		return nil
	}

	var wg sync.WaitGroup
	sem := make(chan struct{}, a.maxWorkers)
	seen := make(map[string]struct{}, len(tasks))
	for _, task := range tasks {
		key := taskKey(task)
		if key != "" {
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
		}
		if !a.markInFlight(key) {
			continue
		}
		wg.Add(1)
		go func(t protocol.CommandTask, k string) {
			defer wg.Done()
			defer a.clearInFlight(k)
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				return
			}
			a.executeAndReport(ctx, t)
		}(task, key)
	}
	wg.Wait()
	return nil
}

func (a *Agent) ensureRegisteredWithRetry(ctx context.Context) error {
	backoff := time.Second
	for {
		err := a.ensureRegistered(ctx)
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		a.logger.Error("agent registration failed; retrying", "err", err, "retry_in", backoff)
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		if backoff < 30*time.Second {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
}

func (a *Agent) ensureRegistered(ctx context.Context) error {
	a.regMu.Lock()
	defer a.regMu.Unlock()

	if a.cfg.StatePath != "" {
		if st, err := state.Load(a.cfg.StatePath); err == nil {
			if st.ServerURL == a.client.BaseURL() && (a.cfg.DeviceID == "" || st.DeviceID == a.cfg.DeviceID) {
				a.setIdentity(st.AgentID, st.DeviceID)
				a.logger.Info("loaded persisted agent state", "agent_id", st.AgentID, "device_id", st.DeviceID)
				return nil
			}
		}
	}

	return a.registerLocked(ctx, a.cfg.DeviceID)
}

func (a *Agent) reRegister(ctx context.Context, failedAgentID string) error {
	a.regMu.Lock()
	defer a.regMu.Unlock()

	currentAgentID, _ := a.identity()
	if currentAgentID != "" && currentAgentID != failedAgentID {
		// Another goroutine already re-registered while we were waiting for regMu.
		return nil
	}

	if a.cfg.StatePath != "" {
		_ = state.Clear(a.cfg.StatePath)
	}
	a.logger.Warn("device not found on server (40010); re-registering agent", "old_agent_id", failedAgentID)
	return a.registerLocked(ctx, a.cfg.DeviceID)
}

func (a *Agent) registerLocked(ctx context.Context, preboundDeviceID string) error {
	name := a.cfg.Name
	if name == "" {
		name = a.platform.Hostname
	}
	if name == "" {
		name, _ = os.Hostname()
	}
	if name == "" {
		name = "cslite-device"
	}

	req := protocol.RegisterRequest{
		Name:      name,
		Platform:  a.platform.Platform,
		Arch:      a.platform.Arch,
		OSVersion: a.platform.OSVersion,
		Hostname:  a.platform.Hostname,
		Version:   a.version,
		DeviceID:  preboundDeviceID,
	}

	resp, err := a.client.Register(ctx, req)
	if err != nil {
		return fmt.Errorf("register: %w", err)
	}
	if resp.AgentID == "" || resp.DeviceID == "" {
		return errors.New("register response missing agent_id or device_id")
	}

	a.setIdentity(resp.AgentID, resp.DeviceID)
	a.lastMetricsSyncNs.Store(0)
	a.applyServerIntervals(resp.HeartbeatInterval, resp.PollInterval)

	if a.cfg.StatePath != "" {
		if err := state.Save(a.cfg.StatePath, &state.State{
			AgentID:   resp.AgentID,
			DeviceID:  resp.DeviceID,
			ServerURL: a.client.BaseURL(),
		}); err != nil {
			a.logger.Warn("failed to persist agent state", "path", a.cfg.StatePath, "err", err)
		}
	}

	a.logger.Info("agent registered", "agent_id", resp.AgentID, "device_id", resp.DeviceID, "platform", a.platform.Platform)
	return nil
}

func heartbeatFallbackThreshold(interval, pollInt time.Duration) time.Duration {
	if pollInt > 0 && pollInt <= interval {
		grace := pollInt / 2
		if grace > 2*time.Second {
			grace = 2 * time.Second
		}
		if grace < 10*time.Millisecond {
			grace = 10 * time.Millisecond
		}
		return interval + pollInt + grace
	}
	return interval
}

func (a *Agent) heartbeatLoop(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()

	for {
		threshold := heartbeatFallbackThreshold(a.getHeartbeatInterval(), a.getPollInterval())
		wait := threshold
		if lastSync := a.lastMetricsSyncNs.Load(); lastSync > 0 {
			elapsed := time.Since(time.Unix(0, lastSync))
			if elapsed < 0 {
				elapsed = 0
			}
			if elapsed < threshold {
				wait = threshold - elapsed
			} else {
				wait = 0
			}
		}

		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			a.metricsSyncMu.Lock()
			if ctx.Err() != nil {
				a.metricsSyncMu.Unlock()
				return
			}
			threshold = heartbeatFallbackThreshold(a.getHeartbeatInterval(), a.getPollInterval())
			lastSync := a.lastMetricsSyncNs.Load()
			if lastSync > 0 && time.Since(time.Unix(0, lastSync)) < threshold {
				a.metricsSyncMu.Unlock()
				a.logger.Debug("skipping standalone heartbeat; telemetry synced via poll")
				continue
			}
			err := a.sendHeartbeatLocked(ctx)
			a.metricsSyncMu.Unlock()
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				a.logger.Error("heartbeat failed", "err", err)
			}
		}
	}
}

func (a *Agent) sendHeartbeat(ctx context.Context) error {
	a.metricsSyncMu.Lock()
	defer a.metricsSyncMu.Unlock()
	return a.sendHeartbeatLocked(ctx)
}

func (a *Agent) sendHeartbeatLocked(ctx context.Context) error {
	agentID, deviceID := a.identity()
	m := a.collector.Collect()
	req := protocol.HeartbeatRequest{
		AgentID:   agentID,
		DeviceID:  deviceID,
		Metrics:   m,
		Version:   a.version,
		OSVersion: a.platform.OSVersion,
		Hostname:  a.platform.Hostname,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}

	resp, err := a.client.Heartbeat(ctx, req)
	if err != nil {
		if client.IsDeviceNotFound(err) {
			if regErr := a.reRegister(ctx, agentID); regErr != nil {
				return regErr
			}
			newAgentID, newDeviceID := a.identity()
			req.AgentID = newAgentID
			req.DeviceID = newDeviceID
			resp, err = a.client.Heartbeat(ctx, req)
			if err != nil {
				return err
			}
		} else {
			return err
		}
	}

	a.lastMetricsSyncNs.Store(time.Now().UnixNano())
	if resp != nil {
		a.applyServerIntervals(resp.NextHeartbeat, resp.PollInterval)
	}
	a.logger.Debug("heartbeat ok", "agent_id", req.AgentID)
	return nil
}

func (a *Agent) pollLoop(ctx context.Context, wg *sync.WaitGroup, taskCh chan<- protocol.CommandTask) {
	defer wg.Done()

	for {
		delay := a.nextPollDelay()
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-a.pollWakeCh:
			timer.Stop()
		case <-timer.C:
		}

		if ctx.Err() != nil {
			return
		}
		a.pollAndDispatch(ctx, taskCh)
	}
}

func (a *Agent) pollAndDispatch(ctx context.Context, taskCh chan<- protocol.CommandTask) {
	slots := a.availableSlots()
	if slots <= 0 {
		a.logger.Debug("all worker slots busy; skipping poll")
		return
	}

	agentID, _ := a.identity()
	tasks, err := a.pollWithRecovery(ctx, agentID, slots)
	if err != nil {
		if ctx.Err() == nil {
			a.logger.Error("poll commands failed", "err", err)
		}
		return
	}

	seen := make(map[string]struct{}, len(tasks))
	for _, task := range tasks {
		key := taskKey(task)
		if key != "" {
			if _, dup := seen[key]; dup {
				a.logger.Debug("skipping duplicate task in poll batch", "key", key)
				continue
			}
			seen[key] = struct{}{}
		}
		if !a.markInFlight(key) {
			a.logger.Debug("skipping duplicate in-flight task", "key", key)
			continue
		}
		select {
		case taskCh <- task:
			a.logger.Info("queued command task", "result_id", task.ResultID, "execution_id", task.ExecutionID, "command_id", task.CommandID)
		case <-ctx.Done():
			a.clearInFlight(key)
			return
		}
	}
}

func (a *Agent) pollWithRecovery(ctx context.Context, agentID string, limit int) ([]protocol.CommandTask, error) {
	lastSync := a.lastMetricsSyncNs.Load()
	includeMetrics := lastSync == 0 || time.Since(time.Unix(0, lastSync)) >= a.getHeartbeatInterval()
	if includeMetrics {
		a.metricsSyncMu.Lock()
		defer a.metricsSyncMu.Unlock()
		lastSync = a.lastMetricsSyncNs.Load()
		includeMetrics = lastSync == 0 || time.Since(time.Unix(0, lastSync)) >= a.getHeartbeatInterval()
	}

	req := protocol.PollCommandsRequest{
		AgentID: agentID,
		Limit:   limit,
	}
	if includeMetrics {
		req.Metrics = a.collector.Collect()
		req.Version = a.version
		req.OSVersion = a.platform.OSVersion
		req.Hostname = a.platform.Hostname
		req.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}

	resp, err := a.client.PollCommandsWithStatus(ctx, req)
	if err != nil && client.IsDeviceNotFound(err) {
		if regErr := a.reRegister(ctx, agentID); regErr != nil {
			return nil, regErr
		}
		newAgentID, _ := a.identity()
		req.AgentID = newAgentID
		if includeMetrics {
			req.Timestamp = time.Now().UTC().Format(time.RFC3339)
		}
		resp, err = a.client.PollCommandsWithStatus(ctx, req)
	}
	if err != nil {
		return nil, err
	}

	if includeMetrics {
		a.lastMetricsSyncNs.Store(time.Now().UnixNano())
	}
	if resp == nil {
		return nil, nil
	}
	a.applyServerIntervals(resp.NextHeartbeat, resp.PollInterval)
	return resp.Commands, nil
}

func (a *Agent) workerLoop(ctx context.Context, wg *sync.WaitGroup, taskCh <-chan protocol.CommandTask) {
	defer wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case task := <-taskCh:
			key := taskKey(task)
			a.executeAndReport(ctx, task)
			a.clearInFlight(key)
			a.triggerFastPoll()
		}
	}
}

func (a *Agent) executeAndReport(ctx context.Context, task protocol.CommandTask) {
	started := time.Now()
	a.logger.Info("executing command", "result_id", task.ResultID, "execution_id", task.ExecutionID, "command_id", task.CommandID, "timeout", task.Timeout)

	res := a.execFn(ctx, exec.Request{
		Content: task.Content,
		Timeout: task.Timeout,
		Shell:   task.Shell,
		EnvVars: task.EnvVars,
	})

	_, deviceID := a.identity()
	reportReq := protocol.ResultRequest{
		ResultID:    task.ResultID,
		ExecutionID: task.ExecutionID,
		DeviceID:    deviceID,
		Status:      res.Status,
		ExitCode:    res.ExitCode,
		Output:      res.Output,
		CompletedAt: time.Now().UTC().Format(time.RFC3339),
	}

	if _, err := a.client.ReportResult(ctx, reportReq); err != nil {
		if ctx.Err() == nil {
			a.logger.Error("failed to report result", "execution_id", task.ExecutionID, "err", err)
		}
		return
	}

	a.logger.Info("reported command result",
		"result_id", task.ResultID,
		"execution_id", task.ExecutionID,
		"status", res.Status,
		"exit_code", res.ExitCode,
		"duration_ms", time.Since(started).Milliseconds(),
	)
}

func (a *Agent) identity() (string, string) {
	a.idMu.RLock()
	defer a.idMu.RUnlock()
	return a.agentID, a.deviceID
}

func (a *Agent) setIdentity(agentID, deviceID string) {
	a.idMu.Lock()
	defer a.idMu.Unlock()
	a.agentID = agentID
	a.deviceID = deviceID
}

func (a *Agent) applyServerIntervals(heartbeatSec, pollSec int) {
	a.intervalMu.Lock()
	defer a.intervalMu.Unlock()
	if !a.cfg.ExplicitHeartbeat && heartbeatSec > 0 {
		a.heartbeatInterval = time.Duration(heartbeatSec) * time.Second
	}
	if !a.cfg.ExplicitPoll && pollSec > 0 {
		a.pollInterval = time.Duration(pollSec) * time.Second
	}
}

func (a *Agent) getHeartbeatInterval() time.Duration {
	a.intervalMu.RLock()
	defer a.intervalMu.RUnlock()
	return a.heartbeatInterval
}

func (a *Agent) getPollInterval() time.Duration {
	a.intervalMu.RLock()
	defer a.intervalMu.RUnlock()
	return a.pollInterval
}

func (a *Agent) nextPollDelay() time.Duration {
	a.intervalMu.RLock()
	base := a.pollInterval
	a.intervalMu.RUnlock()

	a.fastMu.Lock()
	fastActive := time.Now().Before(a.fastPollUntil)
	a.fastMu.Unlock()

	if fastActive && base > fastPollInterval {
		return fastPollInterval
	}
	return base
}

func (a *Agent) triggerFastPoll() {
	a.fastMu.Lock()
	a.fastPollUntil = time.Now().Add(fastPollBurst)
	a.fastMu.Unlock()

	select {
	case a.pollWakeCh <- struct{}{}:
	default:
	}
}

func (a *Agent) availableSlots() int {
	a.flightMu.Lock()
	defer a.flightMu.Unlock()
	free := a.maxWorkers - len(a.inFlight)
	if free < 0 {
		return 0
	}
	return free
}

func (a *Agent) markInFlight(key string) bool {
	if key == "" {
		return true
	}
	a.flightMu.Lock()
	defer a.flightMu.Unlock()
	if _, exists := a.inFlight[key]; exists {
		return false
	}
	a.inFlight[key] = struct{}{}
	return true
}

func (a *Agent) clearInFlight(key string) {
	if key == "" {
		return
	}
	a.flightMu.Lock()
	defer a.flightMu.Unlock()
	delete(a.inFlight, key)
}

func taskKey(t protocol.CommandTask) string {
	if t.ResultID != "" {
		return t.ResultID
	}
	return t.ExecutionID
}
