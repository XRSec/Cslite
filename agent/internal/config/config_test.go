package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPrecedenceCLIOverEnvOverFile(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.json")

	if err := Save(cfgPath, &Config{
		Server:            "https://from-file.example.com",
		APIKey:            "ak_live_file",
		Name:              "file-name",
		DeviceID:          "dev_file",
		PollInterval:      12,
		HeartbeatInterval: 45,
		LogLevel:          "warn",
	}); err != nil {
		t.Fatalf("Save() failed: %v", err)
	}

	t.Setenv("CSLITE_SERVER", "https://from-env.example.com")
	t.Setenv("AGENT_API_KEY", "ak_live_env")
	t.Setenv("CSLITE_POLL_INTERVAL", "8")
	t.Setenv("AGENT_INTERVAL", "90")

	cfg, err := Load(Overrides{
		ConfigFile: cfgPath,
		Server:     "https://from-cli.example.com",
		Name:       "cli-name",
	})
	if err != nil {
		t.Fatalf("Load() failed: %v", err)
	}

	if cfg.Server != "https://from-cli.example.com" {
		t.Fatalf("Server = %q, want CLI value", cfg.Server)
	}
	if cfg.APIKey != "ak_live_env" {
		t.Fatalf("APIKey = %q, want env value", cfg.APIKey)
	}
	if cfg.Name != "cli-name" {
		t.Fatalf("Name = %q, want CLI value", cfg.Name)
	}
	if cfg.DeviceID != "dev_file" {
		t.Fatalf("DeviceID = %q, want file value", cfg.DeviceID)
	}
	if cfg.PollInterval != 8 {
		t.Fatalf("PollInterval = %d, want 8", cfg.PollInterval)
	}
	if cfg.HeartbeatInterval != 90 {
		t.Fatalf("HeartbeatInterval = %d, want 90", cfg.HeartbeatInterval)
	}
	if cfg.LogLevel != "warn" {
		t.Fatalf("LogLevel = %q, want warn", cfg.LogLevel)
	}
}

func TestDotEnvFallbackAndSetKey(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	content := "# comment\nexport CSLITE_SERVER=\"https://dotenv.example.com\"\nAGENT_API_KEY='ak_live_dotenv'\nCSLITE_POLL_INTERVAL=7\n"
	if err := os.WriteFile(envPath, []byte(content), 0600); err != nil {
		t.Fatalf("WriteFile(.env) failed: %v", err)
	}

	t.Setenv("CSLITE_SERVER", "https://os-env-wins.example.com")

	cfg, err := Load(Overrides{ConfigFile: envPath})
	if err != nil {
		t.Fatalf("Load(.env) failed: %v", err)
	}
	if cfg.Server != "https://os-env-wins.example.com" {
		t.Fatalf("Server = %q, want OS env precedence over .env", cfg.Server)
	}
	if cfg.APIKey != "ak_live_dotenv" {
		t.Fatalf("APIKey = %q, want ak_live_dotenv", cfg.APIKey)
	}
	if cfg.PollInterval != 7 {
		t.Fatalf("PollInterval = %d, want 7", cfg.PollInterval)
	}

	jsonPath := filepath.Join(dir, "config.json")
	if _, err := SetKey(jsonPath, "server", "https://updated.example.com"); err != nil {
		t.Fatalf("SetKey(server) failed: %v", err)
	}
	if _, err := SetKey(jsonPath, "poll_interval", "10"); err != nil {
		t.Fatalf("SetKey(poll_interval) failed: %v", err)
	}
	if _, err := SetKey(jsonPath, "unknown", "val"); err == nil {
		t.Fatalf("expected error for unknown config key")
	}
	if _, err := SetKey(jsonPath, "poll_interval", "-1"); err == nil {
		t.Fatalf("expected error for negative poll_interval")
	}

	t.Setenv("CSLITE_SERVER", "")
	loaded, err := Load(Overrides{ConfigFile: jsonPath})
	if err != nil {
		t.Fatalf("Load(jsonPath) failed: %v", err)
	}
	if loaded.Server != "https://updated.example.com" || loaded.PollInterval != 10 {
		t.Fatalf("unexpected loaded config: %+v", loaded)
	}

	t.Setenv("CSLITE_USER_AGENT", "EnvUA/1.0")
	t.Setenv("CSLITE_REFERER", "https://env.example/ref")
	if _, err := SetKey(jsonPath, "user_agent", "FileUA/1.0"); err != nil {
		t.Fatalf("SetKey(user_agent) failed: %v", err)
	}
	if _, err := SetKey(jsonPath, "referer", "https://file.example/ref"); err != nil {
		t.Fatalf("SetKey(referer) failed: %v", err)
	}
	hdrCfg, err := Load(Overrides{ConfigFile: jsonPath, UserAgent: "CliUA/2.0"})
	if err != nil {
		t.Fatalf("Load(hdr) failed: %v", err)
	}
	if hdrCfg.UserAgent != "CliUA/2.0" || hdrCfg.Referer != "https://env.example/ref" {
		t.Fatalf("unexpected header precedence: ua=%q ref=%q", hdrCfg.UserAgent, hdrCfg.Referer)
	}
}
