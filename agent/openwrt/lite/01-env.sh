#!/bin/sh
# Purpose: Ultra-lightweight POSIX/BusyBox CSLite agent (OpenWrt, Linux, macOS, Android).
# Context: Served at /agent-lite.sh; assembled cleanly from agent/openwrt/lite/*.sh.
# Usage: cslite-agent-lite <run|install|uninstall|start|stop|restart|status|version> [options]
# Requires: POSIX sh, awk, and curl, wget, uclient-fetch, or openssl.

VERSION="v1.2.2"

is_termux() {
	[ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ] || [ -d /data/data/com.termux ]
}

is_android() {
	is_termux || command -v getprop >/dev/null 2>&1 || [ -x /system/bin/getprop ]
}

is_openwrt() {
	[ -f /etc/openwrt_release ] || { [ -x /sbin/procd ] && [ ! -d /run/systemd/system ]; }
}

is_writable_dir() {
	[ -n "${1:-}" ] && [ -d "$1" ] || return 1
	probe="${1%/}/.cslite_wr_$$"
	if ( : > "$probe" ) 2>/dev/null; then
		rm -f "$probe" 2>/dev/null || true
		return 0
	fi
	return 1
}

detect_platform() {
	if is_android; then
		printf 'android'
	elif is_openwrt; then
		printf 'openwrt'
	else
		case "$(uname -s 2>/dev/null || echo linux)" in
			Darwin*) printf 'macos' ;;
			*) printf 'linux' ;;
		esac
	fi
}

detect_arch() {
	m="$(uname -m 2>/dev/null || echo unknown)"
	case "$m" in
		x86_64|amd64) printf 'amd64' ;;
		aarch64|arm64) printf 'arm64' ;;
		armv7*) printf 'arm' ;;
		mips64*) printf 'mips64' ;;
		mipsel*|mips*el) printf 'mipsle' ;;
		mips*) printf 'mips' ;;
		*) printf '%s' "$m" ;;
	esac
}

getprop_safe() {
	if command -v getprop >/dev/null 2>&1; then
		getprop "$1" 2>/dev/null | tr -d '\r\n'
	elif [ -x /system/bin/getprop ]; then
		/system/bin/getprop "$1" 2>/dev/null | tr -d '\r\n'
	fi
}

detect_os_version() {
	plat="$(detect_platform)"
	case "$plat" in
		android)
			rel="$(getprop_safe ro.build.version.release || true)"
			model="$(getprop_safe ro.product.model || true)"
			if [ -n "$rel" ] && [ -n "$model" ]; then
				printf 'Android %s (%s)' "$rel" "$model"
				return 0
			elif [ -n "$rel" ]; then
				printf 'Android %s' "$rel"
				return 0
			elif [ -n "$model" ]; then
				printf 'Android (%s)' "$model"
				return 0
			fi
			;;
		macos)
			if command -v sw_vers >/dev/null 2>&1; then
				ver="$(sw_vers -productVersion 2>/dev/null | tr -d '\r\n' || true)"
				if [ -n "$ver" ]; then
					printf 'macOS %s' "$ver"
					return 0
				fi
			fi
			;;
		openwrt)
			if [ -f /etc/openwrt_release ]; then
				ver="$(sed -n 's/^DISTRIB_DESCRIPTION=["'\'']*\([^"'\'']*\)["'\'']*$/\1/p' /etc/openwrt_release 2>/dev/null | head -n 1 || true)"
				if [ -n "$ver" ]; then
					printf '%s' "$ver"
					return 0
				fi
			fi
			;;
	esac
	if [ -f /etc/os-release ]; then
		ver="$(sed -n 's/^PRETTY_NAME=["'\'']*\([^"'\'']*\)["'\'']*$/\1/p' /etc/os-release 2>/dev/null | head -n 1 || true)"
		if [ -n "$ver" ]; then
			printf '%s' "$ver"
			return 0
		fi
	fi
	uname -r 2>/dev/null || true
}

pick_base_tmp_dir() {
	td="${TMPDIR:-}"
	while [ "${td%/}" != "$td" ] && [ "$td" != "/" ]; do
		td="${td%/}"
	done
	if is_writable_dir "$td"; then
		printf '%s' "$td"
		return 0
	fi
	if is_writable_dir "/tmp"; then
		printf '/tmp'
		return 0
	fi
	if [ -n "${PREFIX:-}" ] && is_writable_dir "${PREFIX%/}/tmp"; then
		printf '%s/tmp' "${PREFIX%/}"
		return 0
	fi
	if is_writable_dir "/data/local/tmp"; then
		printf '/data/local/tmp'
		return 0
	fi
	return 1
}

default_config_dir() {
	plat="$(detect_platform)"
	if [ "$plat" = "openwrt" ]; then
		printf '/etc/cslite-agent'
		return 0
	fi
	if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ]; then
		printf '%s/.config/cslite-agent' "${HOME:-/data/data/com.termux/files/home}"
		return 0
	fi
	if [ "$plat" = "android" ] || command -v getprop >/dev/null 2>&1 || [ -x /system/bin/getprop ]; then
		if [ -d /data/adb ] && [ -w /data/adb ]; then
			printf '/data/adb/cslite-agent'
		else
			printf '/data/local/tmp/cslite-agent'
		fi
		return 0
	fi
	if [ "$plat" = "linux" ] && [ "$(id -u 2>/dev/null || echo 1)" -eq 0 ] && [ "${USER_MODE:-0}" -eq 0 ]; then
		printf '/etc/cslite-agent'
		return 0
	fi
	base_home="${HOME:-$(pick_base_tmp_dir || printf '/data/local/tmp')}"
	printf '%s/.config/cslite-agent' "${base_home%/}"
}

pick_tmp_dir() {
	if base_tmp="$(pick_base_tmp_dir)"; then
		printf '%s' "$base_tmp"
		return 0
	fi
	cfg_tmp="${CONFIG_DIR}/tmp"
	mkdir -p "$cfg_tmp" 2>/dev/null || true
	printf '%s' "$cfg_tmp"
}

USER_MODE=0
CONFIG_DIR="${CSLITE_CONFIG_DIR:-$(default_config_dir)}"
CONFIG_FILE="${CSLITE_CONFIG:-$CONFIG_DIR/config.json}"
STATE_FILE="${CSLITE_STATE_FILE:-$CONFIG_DIR/state.json}"
TMP_DIR="$(pick_tmp_dir)"
INIT_SCRIPT="/etc/init.d/cslite-agent"
PID_FILE="${TMP_DIR}/cslite-agent-lite.pid"

SERVER=""
API_KEY=""
DEVICE_NAME=""
DEVICE_ID=""
USER_AGENT=""
REFERER=""
POLL_INTERVAL=""
HEARTBEAT_INTERVAL=""
POLL_EXPLICIT=0
HB_EXPLICIT=0
LOG_LEVEL=""
ONCE_MODE=0
PURGE_MODE=0
IGNORE_EXISTING_CONFIG=0

AGENT_ID=""
BOUND_DEVICE_ID=""
BASE_URL=""
HTTP_CLIENT=""
REQ_UA=""
REQ_REFERER=""
SLEEP_PID=""
LAST_HB_SYNC=0
PREV_CPU_TOTAL=""
PREV_CPU_IDLE=""
PREV_NET_RX=""
PREV_NET_TX=""
PREV_NET_TS=""
METRICS_JSON=""
PROC_STAT_FILE="${CSLITE_PROC_STAT:-/proc/stat}"
PROC_NET_DEV_FILE="${CSLITE_PROC_NET_DEV:-/proc/net/dev}"
PROC_MEMINFO_FILE="${CSLITE_PROC_MEMINFO:-/proc/meminfo}"
PROC_LOADAVG_FILE="${CSLITE_PROC_LOADAVG:-/proc/loadavg}"
PROC_UPTIME_FILE="${CSLITE_PROC_UPTIME:-/proc/uptime}"
METRICS_PRIME_DELAY="${CSLITE_METRICS_PRIME_DELAY:-1}"

log_msg() {
	level="$1"
	shift
	if [ "$level" = "DEBUG" ] && [ "${LOG_LEVEL:-info}" != "debug" ]; then
		return 0
	fi
	printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)" "$level" "$*" >&2
}

probe_http_client() {
	if [ -n "${CSLITE_HTTP_CLIENT:-}" ]; then
		HTTP_CLIENT="$CSLITE_HTTP_CLIENT"
		return 0
	fi
	for candidate in curl /system/bin/curl wget /system/bin/wget uclient-fetch openssl /usr/bin/openssl; do
		found=0
		case "$candidate" in
			/*) [ -x "$candidate" ] && found=1 ;;
			*) command -v "$candidate" >/dev/null 2>&1 && found=1 ;;
		esac
		[ "$found" -eq 1 ] || continue
		case "$candidate" in
			wget|/system/bin/wget)
				help_out="$("$candidate" --help </dev/null 2>&1 || true)"
				case "$help_out" in
					*--header*)
						case "$help_out" in
							*--post-data*) ;;
							*) continue ;;
						esac
						;;
					*) continue ;;
				esac
				;;
		esac
		HTTP_CLIENT="$candidate"
		return 0
	done
	return 1
}

normalize_server_url() {
	u="$1"
	while [ "${u%/}" != "$u" ]; do
		u="${u%/}"
	done
	case "$u" in
		*/api) BASE_URL="$u" ;;
		*) BASE_URL="${u}/api" ;;
	esac
}

