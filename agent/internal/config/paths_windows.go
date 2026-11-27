//go:build windows

package config

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// IsOpenWrt always returns false on Windows.
func IsOpenWrt() bool {
	return false
}

func isElevatedOrService() bool {
	return windows.GetCurrentProcessToken().IsElevated()
}

// DefaultPaths returns OS-appropriate persistent paths on Windows.
func DefaultPaths(userMode bool) Paths {
	if !userMode && isElevatedOrService() {
		programData := os.Getenv("ProgramData")
		if programData == "" {
			programData = `C:\ProgramData`
		}
		dir := filepath.Join(programData, "cslite-agent")
		return Paths{
			ConfigDir:  dir,
			ConfigFile: filepath.Join(dir, "config.json"),
			StateDir:   dir,
			StateFile:  filepath.Join(dir, "state.json"),
			LogFile:    filepath.Join(dir, "cslite-agent.log"),
		}
	}

	appData := os.Getenv("APPDATA")
	if appData == "" {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			appData = filepath.Join(home, "AppData", "Roaming")
		} else {
			appData = os.TempDir()
		}
	}
	dir := filepath.Join(appData, "cslite-agent")
	return Paths{
		ConfigDir:  dir,
		ConfigFile: filepath.Join(dir, "config.json"),
		StateDir:   dir,
		StateFile:  filepath.Join(dir, "state.json"),
		LogFile:    filepath.Join(dir, "cslite-agent.log"),
	}
}
