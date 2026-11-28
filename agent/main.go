package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/XRSec/Cslite/agent/internal/config"
	"github.com/XRSec/Cslite/agent/internal/core"
	"github.com/XRSec/Cslite/agent/internal/exec"
	"github.com/XRSec/Cslite/agent/internal/metrics"
	"github.com/XRSec/Cslite/agent/internal/protocol"
	"github.com/XRSec/Cslite/agent/internal/service"
	_ "golang.org/x/crypto/x509roots/fallback"
)

//go:embed VERSION
var embeddedVersion string

// Version is injected at build time via -ldflags "-X main.Version=...".
// When unset, init() populates it from agent/VERSION.
var Version = ""

func init() {
	if strings.TrimSpace(Version) == "" {
		Version = strings.TrimSpace(embeddedVersion)
		if Version == "" {
			Version = "v1.2.1"
		}
	}
}

func main() {
	if len(os.Args) < 2 {
		if service.IsWindowsService() {
			if err := cmdRun(nil); err != nil {
				os.Exit(1)
			}
			return
		}
		printUsage()
		os.Exit(1)
	}

	subcmd := os.Args[1]
	args := os.Args[2:]

	// Allow legacy invocation with flags directly (e.g. cslite-agent --server ... --key ...).
	if strings.HasPrefix(subcmd, "-") {
		if subcmd == "-h" || subcmd == "--help" || subcmd == "-help" {
			printUsage()
			return
		}
		args = os.Args[1:]
		subcmd = "run"
	}

	var err error
	switch subcmd {
	case "run":
		err = cmdRun(args)
	case "install":
		err = cmdInstall(args)
	case "uninstall":
		err = cmdUninstall(args)
	case "start":
		err = cmdLifecycle("start", args)
	case "stop":
		err = cmdLifecycle("stop", args)
	case "restart":
		err = cmdLifecycle("restart", args)
	case "status":
		err = cmdStatus(args)
	case "config":
		err = cmdConfig(args)
	case "exec":
		err = cmdExec(args)
	case "version", "-v", "--version":
		cmdVersion()
	case "help", "-h", "--help":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", subcmd)
		printUsage()
		os.Exit(2)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Printf(`cslite-agent %s — Lightweight cross-platform Cslite command agent

Usage:
  cslite-agent <command> [options]

Commands:
  run         Run agent in foreground (auto-detects Windows Service SCM)
  install     Save config and install/enable/start OS service
  uninstall   Stop, disable, and remove OS service (--purge removes config/state)
  start       Start installed OS service
  stop        Stop installed OS service
  restart     Restart installed OS service
  status      Show service and registration status
  config      Manage config (config show | config set <key> <value>)
  exec        Execute a local command for diagnostics
  version     Print version, platform, and init system
`, Version)
}

func bindCommonFlags(fs *flag.FlagSet, ov *config.Overrides) {
	fs.StringVar(&ov.Server, "server", "", "Cslite server URL")
	fs.StringVar(&ov.APIKey, "key", "", "Agent API key")
	fs.StringVar(&ov.APIKey, "apikey", "", "Agent API key (alias)")
	fs.StringVar(&ov.APIKey, "api-key", "", "Agent API key (alias)")
	fs.StringVar(&ov.Name, "name", "", "Device display name")
	fs.StringVar(&ov.DeviceID, "device-id", "", "Pre-created device ID")
	fs.StringVar(&ov.UserAgent, "user-agent", "", "Custom HTTP User-Agent header")
	fs.StringVar(&ov.Referer, "referer", "", "Custom HTTP Referer header")
	fs.StringVar(&ov.ConfigFile, "config", "", "Path to config file")
	fs.IntVar(&ov.PollInterval, "poll", 0, "Command poll interval in seconds")
	fs.IntVar(&ov.HeartbeatInterval, "heartbeat", 0, "Heartbeat interval in seconds")
	fs.StringVar(&ov.LogLevel, "log-level", "", "Log level (debug|info|warn|error)")
	fs.BoolVar(&ov.UserMode, "user", false, "Use user-scoped paths and service")
}

func cmdRun(args []string) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	var ov config.Overrides
	var once bool
	bindCommonFlags(fs, &ov)
	fs.BoolVar(&once, "once", false, "Run a single heartbeat/poll/execute cycle and exit")

	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, err := config.Load(ov)
	if err != nil {
		return err
	}
	if cfg.Server == "" || cfg.APIKey == "" {
		return errors.New("server URL and API key are required (--server / --key, env CSLITE_SERVER / CSLITE_API_KEY, or config.json)")
	}

	logger := newLogger(cfg.LogLevel)
	ag, err := core.New(cfg, core.Options{
		Version: Version,
		Logger:  logger,
	})
	if err != nil {
		return err
	}

	if once {
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer cancel()
		return ag.RunOnce(ctx)
	}

	if service.IsWindowsService() {
		return service.RunWindowsService(service.ServiceName, func(ctx context.Context) error {
			return ag.Run(ctx)
		})
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	logger.Info("cslite-agent starting",
		"version", Version,
		"server", cfg.Server,
		"poll_interval", cfg.PollInterval,
		"heartbeat_interval", cfg.HeartbeatInterval,
	)
	return ag.Run(ctx)
}

func cmdInstall(args []string) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	var ov config.Overrides
	bindCommonFlags(fs, &ov)
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, err := config.Load(ov)
	if err != nil {
		return err
	}
	if cfg.Server == "" || cfg.APIKey == "" {
		return errors.New("server URL and API key are required (--server and --key)")
	}

	if err := config.Save(cfg.ConfigPath, cfg); err != nil {
		return fmt.Errorf("save config %s: %w", cfg.ConfigPath, err)
	}

	binPath, err := executablePath()
	if err != nil {
		return err
	}

	if err := service.Install(service.Options{
		BinaryPath: binPath,
		ConfigPath: cfg.ConfigPath,
		LogPath:    cfg.LogPath,
		UserMode:   ov.UserMode,
	}); err != nil {
		return err
	}

	fmt.Printf("Installed and started %s\n  Binary: %s\n  Config: %s\n  State:  %s\n",
		service.ServiceName, binPath, cfg.ConfigPath, cfg.StatePath)
	return nil
}

func cmdUninstall(args []string) error {
	fs := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	var userMode, purge bool
	var configFile string
	fs.BoolVar(&userMode, "user", false, "Uninstall user-scoped service")
	fs.BoolVar(&purge, "purge", false, "Also delete config, state, and log files")
	fs.StringVar(&configFile, "config", "", "Config file path")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if err := service.Uninstall(service.Options{UserMode: userMode}); err != nil {
		return err
	}

	if purge {
		paths := config.ResolvePaths(configFile, userMode)
		for _, p := range []string{paths.ConfigFile, paths.StateFile, paths.LogFile} {
			if p != "" {
				_ = os.Remove(p)
			}
		}
		_ = os.Remove(paths.ConfigDir)
		_ = os.Remove(paths.StateDir)
		fmt.Println("Uninstalled service and purged configuration/state files.")
		return nil
	}

	fmt.Println("Uninstalled service.")
	return nil
}

func cmdLifecycle(action string, args []string) error {
	fs := flag.NewFlagSet(action, flag.ContinueOnError)
	var userMode bool
	fs.BoolVar(&userMode, "user", false, "Target user-scoped service")
	if err := fs.Parse(args); err != nil {
		return err
	}

	opts := service.Options{UserMode: userMode}
	switch action {
	case "start":
		return service.Start(opts)
	case "stop":
		return service.Stop(opts)
	case "restart":
		return service.Restart(opts)
	default:
		return fmt.Errorf("unknown lifecycle action %q", action)
	}
}

func cmdStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	var userMode bool
	var configFile string
	fs.BoolVar(&userMode, "user", false, "Check user-scoped service")
	fs.StringVar(&configFile, "config", "", "Config file path")
	if err := fs.Parse(args); err != nil {
		return err
	}

	paths := config.ResolvePaths(configFile, userMode)
	svcState, err := service.Status(service.Options{UserMode: userMode})
	if err != nil {
		svcState = fmt.Sprintf("error (%v)", err)
	}

	info := metrics.DetectPlatform()
	fmt.Printf("Service:     %s\n", svcState)
	fmt.Printf("Init System: %s\n", service.DetectInitSystem())
	fmt.Printf("Platform:    %s/%s\n", info.Platform, info.Arch)
	fmt.Printf("Config Path: %s\n", paths.ConfigFile)
	fmt.Printf("State Path:  %s\n", paths.StateFile)
	return nil
}

func cmdConfig(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: cslite-agent config <show|set> ...")
	}
	sub := args[0]
	rest := args[1:]

	switch sub {
	case "show":
		fs := flag.NewFlagSet("config show", flag.ContinueOnError)
		var ov config.Overrides
		var reveal bool
		fs.StringVar(&ov.ConfigFile, "config", "", "Config file path")
		fs.BoolVar(&ov.UserMode, "user", false, "Use user-scoped config path")
		fs.BoolVar(&reveal, "reveal", false, "Show unmasked API key")
		if err := fs.Parse(rest); err != nil {
			return err
		}
		cfg, err := config.Load(ov)
		if err != nil {
			return err
		}
		display := *cfg
		if !reveal {
			display.APIKey = config.MaskSecret(display.APIKey)
		}
		out := struct {
			ConfigPath string `json:"config_path"`
			StatePath  string `json:"state_path"`
			LogPath    string `json:"log_path"`
			config.Config
		}{
			ConfigPath: cfg.ConfigPath,
			StatePath:  cfg.StatePath,
			LogPath:    cfg.LogPath,
			Config:     display,
		}
		b, err := json.MarshalIndent(out, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(b))
		return nil

	case "set":
		reordered := reorderFlags(rest, map[string]bool{"config": true})
		fs := flag.NewFlagSet("config set", flag.ContinueOnError)
		var configFile string
		var userMode bool
		fs.StringVar(&configFile, "config", "", "Config file path")
		fs.BoolVar(&userMode, "user", false, "Use user-scoped config path")
		if err := fs.Parse(reordered); err != nil {
			return err
		}
		pos := fs.Args()
		if len(pos) != 2 {
			return errors.New("usage: cslite-agent config set <key> <value>")
		}
		paths := config.ResolvePaths(configFile, userMode)
		if _, err := config.SetKey(paths.ConfigFile, pos[0], pos[1]); err != nil {
			return err
		}
		fmt.Printf("Updated %s in %s\n", pos[0], paths.ConfigFile)
		return nil

	default:
		return fmt.Errorf("unknown config subcommand %q (expected show|set)", sub)
	}
}

func cmdExec(args []string) error {
	reordered := reorderFlags(args, map[string]bool{"timeout": true, "shell": true})
	fs := flag.NewFlagSet("exec", flag.ContinueOnError)
	var timeout int
	var shell string
	fs.IntVar(&timeout, "timeout", 30, "Command timeout in seconds")
	fs.StringVar(&shell, "shell", "", "Shell (sh|bash|ash|cmd|powershell)")
	if err := fs.Parse(reordered); err != nil {
		return err
	}

	pos := fs.Args()
	if len(pos) == 0 {
		return errors.New("usage: cslite-agent exec \"<command>\" [--timeout 30] [--shell sh|bash|cmd|powershell]")
	}
	command := strings.Join(pos, " ")

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	res := exec.Execute(ctx, exec.Request{
		Content: command,
		Timeout: timeout,
		Shell:   shell,
	})
	if res.Output != "" {
		fmt.Println(res.Output)
	}
	if res.Status != protocol.StatusCompleted {
		return fmt.Errorf("command %s (exit_code=%d)", res.Status, res.ExitCode)
	}
	return nil
}

func cmdVersion() {
	info := metrics.DetectPlatform()
	fmt.Printf("cslite-agent %s\n", Version)
	fmt.Printf("os/arch:     %s/%s\n", info.Platform, info.Arch)
	if info.OSVersion != "" {
		fmt.Printf("os_version:  %s\n", info.OSVersion)
	}
	fmt.Printf("init_system: %s\n", service.DetectInitSystem())
}

func newLogger(level string) *slog.Logger {
	var lvl slog.Level
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn", "warning":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lvl}))
}

func executablePath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		return resolved, nil
	}
	return exe, nil
}

// reorderFlags moves recognized flags ahead of positional arguments so users can pass flags before or after positionals.
func reorderFlags(args []string, valueFlags map[string]bool) []string {
	var flagsPart []string
	var posPart []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			posPart = append(posPart, args[i+1:]...)
			break
		}
		if strings.HasPrefix(arg, "-") && arg != "-" {
			name := strings.TrimLeft(arg, "-")
			if eq := strings.IndexByte(name, '='); eq >= 0 {
				flagsPart = append(flagsPart, arg)
				continue
			}
			flagsPart = append(flagsPart, arg)
			if valueFlags[name] && i+1 < len(args) {
				i++
				flagsPart = append(flagsPart, args[i])
			}
			continue
		}
		posPart = append(posPart, arg)
	}
	return append(flagsPart, posPart...)
}
