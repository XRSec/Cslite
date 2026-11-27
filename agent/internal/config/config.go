// Package config manages CLI, environment, and file configuration with OS-aware paths.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	DefaultPollInterval      = 5
	DefaultHeartbeatInterval = 60
	DefaultLogLevel          = "info"
)

// Paths describes OS-specific directories and file locations for the agent.
type Paths struct {
	ConfigDir  string
	ConfigFile string
	StateDir   string
	StateFile  string
	LogFile    string
}

// Config holds the resolved runtime configuration of the agent.
type Config struct {
	Server            string `json:"server"`
	APIKey            string `json:"api_key"`
	Name              string `json:"name,omitempty"`
	DeviceID          string `json:"device_id,omitempty"`
	PollInterval      int    `json:"poll_interval"`
	HeartbeatInterval int    `json:"heartbeat_interval"`
	LogLevel          string `json:"log_level"`

	// Runtime resolved paths (not persisted into config.json).
	ConfigPath string `json:"-"`
	StatePath  string `json:"-"`
	LogPath    string `json:"-"`

	// Tracks whether poll/heartbeat intervals were explicitly specified by user config/env/flag.
	ExplicitPoll      bool `json:"-"`
	ExplicitHeartbeat bool `json:"-"`
}

// Overrides captures CLI flag values. Zero/empty values are treated as unset unless ExplicitlySet flags are true.
type Overrides struct {
	Server            string
	APIKey            string
	Name              string
	DeviceID          string
	ConfigFile        string
	PollInterval      int
	HeartbeatInterval int
	LogLevel          string
	UserMode          bool
}

// ResolvePaths determines the effective config, state, and log paths.
func ResolvePaths(explicitConfig string, userMode bool) Paths {
	p := DefaultPaths(userMode)

	if dir := strings.TrimSpace(os.Getenv("CSLITE_CONFIG_DIR")); dir != "" {
		p.ConfigDir = dir
		p.ConfigFile = filepath.Join(dir, "config.json")
		p.StateDir = dir
		p.StateFile = filepath.Join(dir, "state.json")
		p.LogFile = filepath.Join(dir, "cslite-agent.log")
	}

	if stateFile := strings.TrimSpace(os.Getenv("CSLITE_STATE_FILE")); stateFile != "" {
		p.StateFile = stateFile
		p.StateDir = filepath.Dir(stateFile)
	}

	cfgOverride := strings.TrimSpace(explicitConfig)
	if cfgOverride == "" {
		cfgOverride = strings.TrimSpace(os.Getenv("CSLITE_CONFIG"))
	}
	if cfgOverride != "" {
		p.ConfigFile = cfgOverride
		p.ConfigDir = filepath.Dir(cfgOverride)
	}

	return p
}

// Load resolves configuration with precedence: CLI flags > Env vars > Config file (.json or .env fallback).
func Load(ov Overrides) (*Config, error) {
	paths := ResolvePaths(ov.ConfigFile, ov.UserMode)

	cfg := &Config{
		PollInterval:      DefaultPollInterval,
		HeartbeatInterval: DefaultHeartbeatInterval,
		LogLevel:          DefaultLogLevel,
		ConfigPath:        paths.ConfigFile,
		StatePath:         paths.StateFile,
		LogPath:           paths.LogFile,
	}

	// 1. Load config file (JSON or .env), or fallback to local .env if default JSON config does not exist.
	if err := loadFromFile(paths.ConfigFile, cfg); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("load config %s: %w", paths.ConfigFile, err)
		}
		// Fallback: check .env in current working directory if no explicit config path failed.
		if ov.ConfigFile == "" && strings.TrimSpace(os.Getenv("CSLITE_CONFIG")) == "" {
			if errEnv := loadFromFile(".env", cfg); errEnv != nil && !errors.Is(errEnv, os.ErrNotExist) {
				return nil, fmt.Errorf("load .env: %w", errEnv)
			}
		}
	}

	// 2. Apply environment variables.
	applyEnv(cfg, os.Getenv)

	// 3. Apply CLI flags (highest priority).
	if s := strings.TrimSpace(ov.Server); s != "" {
		cfg.Server = s
	}
	if k := strings.TrimSpace(ov.APIKey); k != "" {
		cfg.APIKey = k
	}
	if n := strings.TrimSpace(ov.Name); n != "" {
		cfg.Name = n
	}
	if d := strings.TrimSpace(ov.DeviceID); d != "" {
		cfg.DeviceID = d
	}
	if ov.PollInterval > 0 {
		cfg.PollInterval = ov.PollInterval
		cfg.ExplicitPoll = true
	}
	if ov.HeartbeatInterval > 0 {
		cfg.HeartbeatInterval = ov.HeartbeatInterval
		cfg.ExplicitHeartbeat = true
	}
	if lvl := strings.TrimSpace(ov.LogLevel); lvl != "" {
		cfg.LogLevel = normalizeLogLevel(lvl)
	}

	if cfg.PollInterval <= 0 {
		cfg.PollInterval = DefaultPollInterval
	}
	if cfg.HeartbeatInterval <= 0 {
		cfg.HeartbeatInterval = DefaultHeartbeatInterval
	}
	cfg.LogLevel = normalizeLogLevel(cfg.LogLevel)

	return cfg, nil
}

func loadFromFile(path string, cfg *Config) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" {
		return nil
	}

	if strings.HasPrefix(trimmed, "{") || strings.EqualFold(filepath.Ext(path), ".json") {
		var fc Config
		if err := json.Unmarshal([]byte(trimmed), &fc); err != nil {
			return err
		}
		if fc.Server != "" {
			cfg.Server = strings.TrimSpace(fc.Server)
		}
		if fc.APIKey != "" {
			cfg.APIKey = strings.TrimSpace(fc.APIKey)
		}
		if fc.Name != "" {
			cfg.Name = strings.TrimSpace(fc.Name)
		}
		if fc.DeviceID != "" {
			cfg.DeviceID = strings.TrimSpace(fc.DeviceID)
		}
		if fc.PollInterval > 0 {
			cfg.PollInterval = fc.PollInterval
			cfg.ExplicitPoll = true
		}
		if fc.HeartbeatInterval > 0 {
			cfg.HeartbeatInterval = fc.HeartbeatInterval
			cfg.ExplicitHeartbeat = true
		}
		if fc.LogLevel != "" {
			cfg.LogLevel = normalizeLogLevel(fc.LogLevel)
		}
		return nil
	}

	// Parse .env KEY=VALUE pairs as file-level fallback.
	envMap := parseDotEnv(trimmed)
	applyEnv(cfg, func(key string) string {
		return envMap[key]
	})
	return nil
}

func parseDotEnv(content string) map[string]string {
	result := make(map[string]string)
	for _, rawLine := range strings.Split(content, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		line = strings.TrimSpace(line)
		idx := strings.IndexByte(line, '=')
		if idx <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		val := strings.TrimSpace(line[idx+1:])
		if len(val) >= 2 {
			if (val[0] == '"' && val[len(val)-1] == '"') || (val[0] == '\'' && val[len(val)-1] == '\'') {
				val = val[1 : len(val)-1]
			} else if hashIdx := strings.Index(val, " #"); hashIdx >= 0 {
				val = strings.TrimSpace(val[:hashIdx])
			}
		}
		if key != "" {
			result[key] = val
		}
	}
	return result
}

func applyEnv(cfg *Config, getenv func(string) string) {
	if v := firstNonEmpty(getenv, "CSLITE_SERVER", "AGENT_SERVER"); v != "" {
		cfg.Server = v
	}
	if v := firstNonEmpty(getenv, "CSLITE_API_KEY", "AGENT_API_KEY", "AGENT_KEY"); v != "" {
		cfg.APIKey = v
	}
	if v := firstNonEmpty(getenv, "CSLITE_NAME", "AGENT_NAME"); v != "" {
		cfg.Name = v
	}
	if v := firstNonEmpty(getenv, "CSLITE_DEVICE_ID", "AGENT_DEVICE_ID"); v != "" {
		cfg.DeviceID = v
	}
	if v := firstNonEmpty(getenv, "CSLITE_POLL_INTERVAL"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.PollInterval = n
			cfg.ExplicitPoll = true
		}
	}
	if v := firstNonEmpty(getenv, "CSLITE_HEARTBEAT_INTERVAL", "AGENT_INTERVAL"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.HeartbeatInterval = n
			cfg.ExplicitHeartbeat = true
		}
	}
	if v := firstNonEmpty(getenv, "CSLITE_LOG_LEVEL", "AGENT_LOG_LEVEL"); v != "" {
		cfg.LogLevel = normalizeLogLevel(v)
	}
}

func firstNonEmpty(getenv func(string) string, keys ...string) string {
	for _, k := range keys {
		if v := strings.TrimSpace(getenv(k)); v != "" {
			return v
		}
	}
	return ""
}

func normalizeLogLevel(level string) string {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug", "info", "warn", "warning", "error":
		if strings.ToLower(strings.TrimSpace(level)) == "warning" {
			return "warn"
		}
		return strings.ToLower(strings.TrimSpace(level))
	default:
		return DefaultLogLevel
	}
}

// Save writes configuration atomically to disk with 0600 permissions.
func Save(path string, cfg *Config) error {
	if cfg == nil {
		return errors.New("nil config")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	toWrite := *cfg
	if toWrite.PollInterval <= 0 {
		toWrite.PollInterval = DefaultPollInterval
	}
	if toWrite.HeartbeatInterval <= 0 {
		toWrite.HeartbeatInterval = DefaultHeartbeatInterval
	}
	toWrite.LogLevel = normalizeLogLevel(toWrite.LogLevel)

	data, err := json.MarshalIndent(toWrite, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	tmp, err := os.CreateTemp(dir, ".config-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = tmp.Close()
			_ = os.Remove(tmpPath)
		}
	}()

	if err := tmp.Chmod(0600); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	cleanup = false
	return nil
}

// SetKey updates a single supported configuration key in the JSON config file.
func SetKey(path, key, value string) (*Config, error) {
	cfg := &Config{
		PollInterval:      DefaultPollInterval,
		HeartbeatInterval: DefaultHeartbeatInterval,
		LogLevel:          DefaultLogLevel,
		ConfigPath:        path,
	}
	if err := loadFromFile(path, cfg); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}

	switch strings.ToLower(strings.TrimSpace(key)) {
	case "server":
		cfg.Server = strings.TrimSpace(value)
	case "api_key":
		cfg.APIKey = strings.TrimSpace(value)
	case "name":
		cfg.Name = strings.TrimSpace(value)
	case "device_id":
		cfg.DeviceID = strings.TrimSpace(value)
	case "poll_interval":
		n, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil || n <= 0 {
			return nil, fmt.Errorf("invalid poll_interval %q: must be positive integer", value)
		}
		cfg.PollInterval = n
	case "heartbeat_interval":
		n, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil || n <= 0 {
			return nil, fmt.Errorf("invalid heartbeat_interval %q: must be positive integer", value)
		}
		cfg.HeartbeatInterval = n
	case "log_level":
		lvl := strings.ToLower(strings.TrimSpace(value))
		switch lvl {
		case "debug", "info", "warn", "error":
			cfg.LogLevel = lvl
		default:
			return nil, fmt.Errorf("invalid log_level %q: expected debug|info|warn|error", value)
		}
	default:
		return nil, fmt.Errorf("unsupported config key %q (supported: server, api_key, name, device_id, poll_interval, heartbeat_interval, log_level)", key)
	}

	if err := Save(path, cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

// MaskSecret obscures API keys for terminal display.
func MaskSecret(s string) string {
	if s == "" {
		return ""
	}
	if len(s) <= 8 {
		return "****"
	}
	return s[:8] + "..." + s[len(s)-4:]
}
