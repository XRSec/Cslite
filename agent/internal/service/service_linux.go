//go:build linux

package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"

	"github.com/XRSec/Cslite/agent/internal/config"
)

const openWrtInitPath = "/etc/init.d/" + ServiceName

// DetectInitSystem returns "procd" on OpenWrt, "systemd" when systemd is active, or "unknown".
func DetectInitSystem() string {
	if config.IsOpenWrt() {
		return "procd"
	}
	if _, err := os.Stat("/run/systemd/system"); err == nil {
		return "systemd"
	}
	if _, err := osexec.LookPath("systemctl"); err == nil {
		return "systemd"
	}
	return "unknown"
}

// IsWindowsService always returns false on Linux.
func IsWindowsService() bool {
	return false
}

// RunWindowsService is unsupported on Linux.
func RunWindowsService(_ string, _ func(ctx context.Context) error) error {
	return errors.New("windows service mode is only supported on windows")
}

// Install installs, enables, and starts the agent service using procd or systemd.
func Install(opts Options) error {
	if config.IsOpenWrt() {
		return installOpenWrt(opts)
	}
	return installSystemd(opts)
}

// Uninstall stops, disables, and removes the OS service definition.
func Uninstall(opts Options) error {
	if config.IsOpenWrt() {
		return uninstallOpenWrt()
	}
	return uninstallSystemd(opts)
}

// Start starts the installed service.
func Start(opts Options) error {
	if config.IsOpenWrt() {
		return runCmd(openWrtInitPath, "start")
	}
	return systemctl(opts.UserMode, "start", ServiceName)
}

// Stop stops the installed service.
func Stop(opts Options) error {
	if config.IsOpenWrt() {
		return runCmd(openWrtInitPath, "stop")
	}
	return systemctl(opts.UserMode, "stop", ServiceName)
}

// Restart restarts the installed service.
func Restart(opts Options) error {
	if config.IsOpenWrt() {
		return runCmd(openWrtInitPath, "restart")
	}
	return systemctl(opts.UserMode, "restart", ServiceName)
}

// Status reports current service state.
func Status(opts Options) (string, error) {
	if config.IsOpenWrt() {
		if _, err := os.Stat(openWrtInitPath); errors.Is(err, os.ErrNotExist) {
			return "not installed", nil
		}
		if err := osexec.Command(openWrtInitPath, "running").Run(); err == nil {
			return "running (procd)", nil
		}
		return "stopped (procd)", nil
	}

	args := []string{"is-active", ServiceName}
	if opts.UserMode {
		args = append([]string{"--user"}, args...)
	}
	out, err := osexec.Command("systemctl", args...).CombinedOutput()
	state := strings.TrimSpace(string(out))
	if state == "" && err != nil {
		return "unknown", err
	}
	return state, nil
}

func installOpenWrt(opts Options) error {
	script := RenderOpenWrtInit(opts.BinaryPath, opts.ConfigPath, opts.LogPath)
	if err := os.MkdirAll(filepath.Dir(openWrtInitPath), 0755); err != nil {
		return err
	}
	if err := os.WriteFile(openWrtInitPath, []byte(script), 0755); err != nil {
		return err
	}
	if err := runCmd(openWrtInitPath, "enable"); err != nil {
		return err
	}
	_ = runCmd(openWrtInitPath, "stop")
	return runCmd(openWrtInitPath, "start")
}

func uninstallOpenWrt() error {
	if _, err := os.Stat(openWrtInitPath); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	_ = runCmd(openWrtInitPath, "stop")
	_ = runCmd(openWrtInitPath, "disable")
	return os.Remove(openWrtInitPath)
}

func systemdUnitPath(userMode bool) (string, error) {
	if !userMode && os.Geteuid() == 0 {
		return "/etc/systemd/system/" + ServiceName + ".service", nil
	}
	cfgDir, err := os.UserConfigDir()
	if err != nil || cfgDir == "" {
		home, hErr := os.UserHomeDir()
		if hErr != nil {
			return "", hErr
		}
		cfgDir = filepath.Join(home, ".config")
	}
	return filepath.Join(cfgDir, "systemd", "user", ServiceName+".service"), nil
}

func installSystemd(opts Options) error {
	userMode := opts.UserMode || os.Geteuid() != 0
	unitPath, err := systemdUnitPath(userMode)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(unitPath), 0755); err != nil {
		return err
	}
	unit := RenderSystemdUnit(opts.BinaryPath, opts.ConfigPath, userMode)
	if err := os.WriteFile(unitPath, []byte(unit), 0644); err != nil {
		return err
	}
	if err := systemctl(userMode, "daemon-reload"); err != nil {
		return err
	}
	return systemctl(userMode, "enable", "--now", ServiceName)
}

func uninstallSystemd(opts Options) error {
	userMode := opts.UserMode || os.Geteuid() != 0
	unitPath, err := systemdUnitPath(userMode)
	if err != nil {
		return err
	}
	_ = systemctl(userMode, "disable", "--now", ServiceName)
	if err := os.Remove(unitPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_ = systemctl(userMode, "daemon-reload")
	return nil
}

func systemctl(userMode bool, args ...string) error {
	if userMode {
		args = append([]string{"--user"}, args...)
	}
	return runCmd("systemctl", args...)
}

func runCmd(name string, args ...string) error {
	out, err := osexec.Command(name, args...).CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg != "" {
			return fmt.Errorf("%s %s: %w (%s)", name, strings.Join(args, " "), err, msg)
		}
		return fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
	}
	return nil
}
