package service

import (
	"strings"
	"testing"
)

func TestRenderOpenWrtInit(t *testing.T) {
	out := RenderOpenWrtInit("/usr/bin/cslite-agent", "/etc/cslite-agent/config.json", "/tmp/cslite-agent.log")
	required := []string{
		"#!/bin/sh /etc/rc.common",
		"USE_PROCD=1",
		"START=99",
		"STOP=10",
		"procd_open_instance",
		`procd_set_param command "$PROG" run --config "$CONF"`,
		"procd_set_param respawn",
		"procd_set_param stdout 1",
		"procd_set_param stderr 1",
		"procd_close_instance",
	}
	for _, needle := range required {
		if !strings.Contains(out, needle) {
			t.Errorf("RenderOpenWrtInit missing %q:\n%s", needle, out)
		}
	}
}

func TestRenderSystemdUnit(t *testing.T) {
	sysUnit := RenderSystemdUnit("/usr/local/bin/cslite-agent", "/etc/cslite-agent/config.json", false)
	if !strings.Contains(sysUnit, "ExecStart=/usr/local/bin/cslite-agent run --config /etc/cslite-agent/config.json") {
		t.Errorf("unexpected system unit ExecStart:\n%s", sysUnit)
	}
	if !strings.Contains(sysUnit, "WantedBy=multi-user.target") {
		t.Errorf("system unit missing multi-user.target:\n%s", sysUnit)
	}

	userUnit := RenderSystemdUnit("/home/alice/.local/bin/cslite-agent", "/home/alice/.config/cslite-agent/config.json", true)
	if !strings.Contains(userUnit, "WantedBy=default.target") {
		t.Errorf("user unit missing default.target:\n%s", userUnit)
	}
}

func TestRenderLaunchdPlist(t *testing.T) {
	plist := RenderLaunchdPlist(
		LaunchdLabel,
		"/usr/local/bin/cslite-agent",
		"/Library/Application Support/cslite-agent/config.json",
		"/Library/Logs/cslite-agent.log",
	)
	required := []string{
		"<string>com.cslite.agent</string>",
		"<string>/usr/local/bin/cslite-agent</string>",
		"<string>run</string>",
		"<string>--config</string>",
		"<string>/Library/Application Support/cslite-agent/config.json</string>",
		"<key>RunAtLoad</key>",
		"<true/>",
		"<key>KeepAlive</key>",
	}
	for _, needle := range required {
		if !strings.Contains(plist, needle) {
			t.Errorf("RenderLaunchdPlist missing %q:\n%s", needle, plist)
		}
	}
}
