package service

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"strings"
)

// RenderOpenWrtInit produces an frpc-style procd /etc/init.d/cslite-agent script.
func RenderOpenWrtInit(binPath, configPath, logPath string) string {
	if binPath == "" {
		binPath = "/usr/bin/cslite-agent"
	}
	if configPath == "" {
		configPath = "/etc/cslite-agent/config.json"
	}
	return fmt.Sprintf(`#!/bin/sh /etc/rc.common
# Cslite Agent OpenWrt procd init script

START=99
STOP=10
USE_PROCD=1

PROG=%s
CONF=%s

start_service() {
	[ -x "$PROG" ] || return 1

	procd_open_instance
	procd_set_param command "$PROG" run --config "$CONF"
	procd_set_param respawn ${respawn_threshold:-3600} ${respawn_timeout:-5} ${respawn_retry:-5}
	procd_set_param stdout 1
	procd_set_param stderr 1
	if [ -f "$CONF" ]; then
		procd_set_param file "$CONF"
	fi
	procd_close_instance
}

reload_service() {
	stop
	start
}

service_triggers() {
	procd_add_reload_trigger "cslite-agent"
}
`, shellQuote(binPath), shellQuote(configPath))
}

// RenderSystemdUnit produces a systemd unit file for system or user scope.
func RenderSystemdUnit(binPath, configPath string, userMode bool) string {
	wantedBy := "multi-user.target"
	after := "network-online.target"
	wants := "Wants=network-online.target\n"
	if userMode {
		wantedBy = "default.target"
		after = "default.target"
		wants = ""
	}
	return fmt.Sprintf(`[Unit]
Description=Cslite Cross-Platform Agent
After=%s
%s
[Service]
Type=simple
ExecStart=%s run --config %s
Restart=always
RestartSec=5

[Install]
WantedBy=%s
`, after, wants, systemdQuote(binPath), systemdQuote(configPath), wantedBy)
}

// RenderLaunchdPlist produces a macOS launchd plist XML document.
func RenderLaunchdPlist(label, binPath, configPath, logPath string) string {
	if label == "" {
		label = LaunchdLabel
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>%s</string>
	<key>ProgramArguments</key>
	<array>
		<string>%s</string>
		<string>run</string>
		<string>--config</string>
		<string>%s</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>%s</string>
	<key>StandardErrorPath</key>
	<string>%s</string>
</dict>
</plist>
`, xmlEscape(label), xmlEscape(binPath), xmlEscape(configPath), xmlEscape(logPath), xmlEscape(logPath))
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

func systemdQuote(s string) string {
	if !strings.ContainsAny(s, " \t\n\"\\") {
		return s
	}
	escaped := strings.ReplaceAll(s, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, `"`, `\"`)
	return `"` + escaped + `"`
}

func xmlEscape(s string) string {
	var buf bytes.Buffer
	_ = xml.EscapeText(&buf, []byte(s))
	return buf.String()
}
