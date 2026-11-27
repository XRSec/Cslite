//go:build darwin

package config

import (
	"os"
	"path/filepath"
)

// IsOpenWrt always returns false on macOS.
func IsOpenWrt() bool {
	return false
}

// DefaultPaths returns OS-appropriate persistent paths on macOS.
func DefaultPaths(userMode bool) Paths {
	if !userMode && os.Geteuid() == 0 {
		dir := "/Library/Application Support/cslite-agent"
		return Paths{
			ConfigDir:  dir,
			ConfigFile: filepath.Join(dir, "config.json"),
			StateDir:   dir,
			StateFile:  filepath.Join(dir, "state.json"),
			LogFile:    "/Library/Logs/cslite-agent.log",
		}
	}

	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = "/tmp"
	}
	dir := filepath.Join(home, "Library", "Application Support", "cslite-agent")
	return Paths{
		ConfigDir:  dir,
		ConfigFile: filepath.Join(dir, "config.json"),
		StateDir:   dir,
		StateFile:  filepath.Join(dir, "state.json"),
		LogFile:    filepath.Join(home, "Library", "Logs", "cslite-agent.log"),
	}
}
