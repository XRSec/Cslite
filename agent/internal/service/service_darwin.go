//go:build darwin

package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
)

// DetectInitSystem returns "launchd" on macOS.
func DetectInitSystem() string {
	return "launchd"
}

// IsWindowsService always returns false on macOS.
func IsWindowsService() bool {
	return false
}

// RunWindowsService is unsupported on macOS.
func RunWindowsService(_ string, _ func(ctx context.Context) error) error {
	return errors.New("windows service mode is only supported on windows")
}

func launchdScope(userMode bool) (plistPath string, domain string, err error) {
	if !userMode && os.Geteuid() == 0 {
		return filepath.Join("/Library/LaunchDaemons", LaunchdLabel+".plist"), "system", nil
	}
	home, hErr := os.UserHomeDir()
	if hErr != nil || home == "" {
		return "", "", errors.New("unable to determine user home directory")
	}
	return filepath.Join(home, "Library", "LaunchAgents", LaunchdLabel+".plist"), fmt.Sprintf("gui/%d", os.Getuid()), nil
}

// Install installs and loads the launchd plist service.
func Install(opts Options) error {
	plistPath, domain, err := launchdScope(opts.UserMode)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(plistPath), 0755); err != nil {
		return err
	}
	if opts.LogPath != "" {
		if err := os.MkdirAll(filepath.Dir(opts.LogPath), 0755); err != nil {
			return err
		}
	}

	plist := RenderLaunchdPlist(LaunchdLabel, opts.BinaryPath, opts.ConfigPath, opts.LogPath)
	if err := os.WriteFile(plistPath, []byte(plist), 0644); err != nil {
		return err
	}

	_ = runLaunchctl("bootout", domain+"/"+LaunchdLabel)
	if err := runLaunchctl("bootstrap", domain, plistPath); err != nil {
		// Fallback for older macOS environments.
		if loadErr := runLaunchctl("load", "-w", plistPath); loadErr != nil {
			return err
		}
	}
	_ = runLaunchctl("kickstart", "-k", domain+"/"+LaunchdLabel)
	return nil
}

// Uninstall unloads and removes the launchd plist service.
func Uninstall(opts Options) error {
	plistPath, domain, err := launchdScope(opts.UserMode)
	if err != nil {
		return err
	}
	if err := runLaunchctl("bootout", domain+"/"+LaunchdLabel); err != nil {
		_ = runLaunchctl("unload", "-w", plistPath)
	}
	if err := os.Remove(plistPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// Start starts the launchd service.
func Start(opts Options) error {
	plistPath, domain, err := launchdScope(opts.UserMode)
	if err != nil {
		return err
	}
	if err := runLaunchctl("kickstart", "-k", domain+"/"+LaunchdLabel); err != nil {
		if bootErr := runLaunchctl("bootstrap", domain, plistPath); bootErr != nil {
			return runLaunchctl("load", "-w", plistPath)
		}
	}
	return nil
}

// Stop stops the launchd service.
func Stop(opts Options) error {
	plistPath, domain, err := launchdScope(opts.UserMode)
	if err != nil {
		return err
	}
	if err := runLaunchctl("bootout", domain+"/"+LaunchdLabel); err != nil {
		return runLaunchctl("unload", plistPath)
	}
	return nil
}

// Restart restarts the launchd service.
func Restart(opts Options) error {
	_ = Stop(opts)
	return Start(opts)
}

// Status checks launchd registration state.
func Status(opts Options) (string, error) {
	plistPath, domain, err := launchdScope(opts.UserMode)
	if err != nil {
		return "unknown", err
	}
	if _, err := os.Stat(plistPath); errors.Is(err, os.ErrNotExist) {
		return "not installed", nil
	}
	out, err := osexec.Command("launchctl", "print", domain+"/"+LaunchdLabel).CombinedOutput()
	if err == nil {
		if strings.Contains(string(out), "state = running") {
			return "running (launchd)", nil
		}
		return "loaded (launchd)", nil
	}
	if err := osexec.Command("launchctl", "list", LaunchdLabel).Run(); err == nil {
		return "loaded (launchd)", nil
	}
	return "stopped (launchd)", nil
}

func runLaunchctl(args ...string) error {
	out, err := osexec.Command("launchctl", args...).CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg != "" {
			return fmt.Errorf("launchctl %s: %w (%s)", strings.Join(args, " "), err, msg)
		}
		return fmt.Errorf("launchctl %s: %w", strings.Join(args, " "), err)
	}
	return nil
}
