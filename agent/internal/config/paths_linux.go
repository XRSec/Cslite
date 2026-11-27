//go:build linux

package config

import (
	"os"
	"path/filepath"
)

// IsOpenWrt reports whether the host looks like an OpenWrt / procd system.
func IsOpenWrt() bool {
	return detectOpenWrt(fileExists)
}

func detectOpenWrt(exists func(string) bool) bool {
	if exists("/etc/openwrt_release") {
		return true
	}
	return exists("/sbin/procd") && !exists("/run/systemd/system")
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// DefaultPaths returns OS-appropriate persistent config, state, and log paths on Linux/OpenWrt.
func DefaultPaths(userMode bool) Paths {
	if IsOpenWrt() {
		if !userMode || os.Geteuid() == 0 {
			// OpenWrt /var is RAM tmpfs; persist both config and state under /etc/cslite-agent.
			return Paths{
				ConfigDir:  "/etc/cslite-agent",
				ConfigFile: "/etc/cslite-agent/config.json",
				StateDir:   "/etc/cslite-agent",
				StateFile:  "/etc/cslite-agent/state.json",
				LogFile:    "/tmp/cslite-agent.log",
			}
		}
	}

	if !userMode && os.Geteuid() == 0 {
		return Paths{
			ConfigDir:  "/etc/cslite-agent",
			ConfigFile: "/etc/cslite-agent/config.json",
			StateDir:   "/var/lib/cslite-agent",
			StateFile:  "/var/lib/cslite-agent/state.json",
			LogFile:    "/var/log/cslite-agent.log",
		}
	}

	base := userConfigBase()
	dir := filepath.Join(base, "cslite-agent")
	return Paths{
		ConfigDir:  dir,
		ConfigFile: filepath.Join(dir, "config.json"),
		StateDir:   dir,
		StateFile:  filepath.Join(dir, "state.json"),
		LogFile:    filepath.Join(dir, "cslite-agent.log"),
	}
}

func userConfigBase() string {
	if dir, err := os.UserConfigDir(); err == nil && dir != "" {
		return dir
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".config")
	}
	return "/tmp"
}
