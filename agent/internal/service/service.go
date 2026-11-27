// Package service manages OS service installation and lifecycle across Linux, OpenWrt, macOS, and Windows.
package service

const (
	// ServiceName is the standard OS service identifier.
	ServiceName = "cslite-agent"
	// LaunchdLabel is the macOS launchd service label.
	LaunchdLabel = "com.cslite.agent"
)

// Options holds service installation/control parameters.
type Options struct {
	BinaryPath string
	ConfigPath string
	LogPath    string
	UserMode   bool
}
