#!/bin/sh
# Cslite Android Auto-Detect Installer (Termux / Magisk / KernelSU / ADB shell)
# POSIX sh compatible with Termux sh/bash and Android /system/bin/sh (mksh).

set -eu

DEFAULT_SERVER="__CSLITE_DEFAULT_SERVER__"

SERVER=""
API_KEY=""
DEVICE_NAME=""
DEVICE_ID=""
POLL_INTERVAL="${CSLITE_POLL_INTERVAL:-}"
HEARTBEAT_INTERVAL="${CSLITE_HEARTBEAT_INTERVAL:-}"
BIN_URL="${CSLITE_BIN_URL:-}"
VERSION="${CSLITE_VERSION:-latest}"
LITE_MODE=0
[ "${CSLITE_LITE:-0}" = "1" ] && LITE_MODE=1
EXPLICIT_LITE="$LITE_MODE"

REPO_DEFAULT="XRSec/Cslite"

usage() {
	cat <<EOF
Usage: install-android.sh [--server <url>] [--key <api_key>] [options]
   or: install-android.sh <api_key> [device_id] [name]

Options:
  --server <url>       Cslite server URL (or CSLITE_SERVER)
  --key <api_key>      Agent API key (or CSLITE_API_KEY)
  --name <name>        Device display name (or CSLITE_NAME)
  --device-id <id>     Pre-created device ID (or CSLITE_DEVICE_ID)
  --poll <seconds>     Command poll interval (or CSLITE_POLL_INTERVAL)
  --heartbeat <sec>    Heartbeat interval (or CSLITE_HEARTBEAT_INTERVAL)
  --lite               Install lightweight shell agent (cslite-agent-lite)
  --bin-url <url>      Custom download URL or local path for agent binary/script
  --version <tag>      Release version tag (default: latest)
  -h, --help           Show this help
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--server) [ $# -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }; SERVER="$2"; shift 2 ;;
		--server=*) SERVER="${1#*=}"; shift ;;
		--key|--apikey|--api-key) [ $# -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }; API_KEY="$2"; shift 2 ;;
		--key=*|--apikey=*|--api-key=*) API_KEY="${1#*=}"; shift ;;
		--name) [ $# -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }; DEVICE_NAME="$2"; shift 2 ;;
		--name=*) DEVICE_NAME="${1#*=}"; shift ;;
		--device-id) [ $# -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }; DEVICE_ID="$2"; shift 2 ;;
		--device-id=*) DEVICE_ID="${1#*=}"; shift ;;
		--poll) [ $# -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }; POLL_INTERVAL="$2"; shift 2 ;;
		--poll=*) POLL_INTERVAL="${1#*=}"; shift ;;
		--heartbeat) [ $# -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }; HEARTBEAT_INTERVAL="$2"; shift 2 ;;
		--heartbeat=*) HEARTBEAT_INTERVAL="${1#*=}"; shift ;;
		--bin-url) [ $# -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }; BIN_URL="$2"; shift 2 ;;
		--bin-url=*) BIN_URL="${1#*=}"; shift ;;
		--version) [ $# -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }; VERSION="$2"; shift 2 ;;
		--version=*) VERSION="${1#*=}"; shift ;;
		--lite) LITE_MODE=1; EXPLICIT_LITE=1; shift ;;
		--user) shift ;;
		-h|--help) usage; exit 0 ;;
		--) shift ;;
		-*) echo "Unknown option: $1" >&2; usage; exit 2 ;;
		*)
			if [ -z "$API_KEY" ]; then
				API_KEY="$1"
			elif [ -z "$DEVICE_ID" ]; then
				DEVICE_ID="$1"
			elif [ -z "$DEVICE_NAME" ]; then
				DEVICE_NAME="$1"
			else
				echo "Unknown option: $1" >&2
				usage
				exit 2
			fi
			shift
			;;
	esac
done

if [ -z "$SERVER" ]; then
	SERVER="${CSLITE_SERVER:-}"
fi
if [ -z "$SERVER" ]; then
	case "$DEFAULT_SERVER" in
		__CSLITE_*) ;;
		http://*|https://*) SERVER="$DEFAULT_SERVER" ;;
	esac
fi
if [ -z "$API_KEY" ]; then
	API_KEY="${CSLITE_API_KEY:-}"
fi
if [ -z "$DEVICE_NAME" ]; then
	DEVICE_NAME="${CSLITE_NAME:-}"
fi
if [ -z "$DEVICE_ID" ]; then
	DEVICE_ID="${CSLITE_DEVICE_ID:-}"
fi

if [ -z "$SERVER" ] || [ -z "$API_KEY" ]; then
	echo "Error: --server and --key (or CSLITE_SERVER and CSLITE_API_KEY) are required." >&2
	usage
	exit 1
fi

SERVER_BASE="$SERVER"
while [ "${SERVER_BASE%/}" != "$SERVER_BASE" ]; do
	SERVER_BASE="${SERVER_BASE%/}"
done
case "$SERVER_BASE" in
	*/api) SERVER_BASE="${SERVER_BASE%/api}" ;;
esac

is_termux() {
	[ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ]
}

is_writable_dir() {
	[ -n "${1:-}" ] && [ -d "$1" ] && [ -w "$1" ]
}

resolve_shell_bin() {
	if [ -x /bin/sh ]; then
		printf '/bin/sh'
	elif [ -n "${PREFIX:-}" ] && [ -x "${PREFIX%/}/bin/sh" ]; then
		printf '%s/bin/sh' "${PREFIX%/}"
	elif [ -x /system/bin/sh ]; then
		printf '/system/bin/sh'
	elif command -v sh >/dev/null 2>&1; then
		command -v sh
	else
		printf '/system/bin/sh'
	fi
}

detect_arch() {
	m="$(uname -m 2>/dev/null || echo arm64)"
	case "$m" in
		aarch64|arm64|armv8*) printf 'arm64' ;;
		armv7*|armhf|armv6*|arm*) printf 'armv7' ;;
		x86_64|amd64) printf 'amd64' ;;
		i*86|x86) printf '386' ;;
		*) printf '%s' "$m" ;;
	esac
}

probe_downloader() {
	for cand in curl wget /system/bin/curl /system/bin/wget; do
		if command -v "$cand" >/dev/null 2>&1 || [ -x "$cand" ]; then
			printf '%s' "$cand"
			return 0
		fi
	done
	for bb in /data/adb/magisk/busybox /data/adb/ksu/bin/busybox /data/adb/ap/bin/busybox; do
		if [ -x "$bb" ]; then
			printf 'busybox:%s' "$bb"
			return 0
		fi
	done
	if command -v toybox >/dev/null 2>&1 && toybox --help wget >/dev/null 2>&1; then
		printf 'toybox'
		return 0
	fi
	echo "Error: curl or wget is required on Android (install curl in Termux or BusyBox)." >&2
	exit 1
}

probe_wget_timeout_flags() {
	bin="$1"
	subcmd="${2:-}"
	if [ -n "$subcmd" ]; then
		help_out="$("$bin" "$subcmd" --help </dev/null 2>&1 || true)"
	else
		help_out="$("$bin" --help </dev/null 2>&1 || true)"
	fi
	norm_help=" $(printf '%s' "$help_out" | tr '\t\r\n' '   ') "
	has_T=0
	has_t=0
	case "$norm_help" in
		*--timeout*|*' -T '*|*'[-T '*|*' -T,'*|*' -T='*|*' -T<'*) has_T=1 ;;
	esac
	case "$norm_help" in
		*--tries*|*' -t '*|*'[-t '*|*' -t,'*|*' -t='*|*' -t<'*) has_t=1 ;;
	esac
	printf '%s:%s' "$has_T" "$has_t"
}

fetch_file() {
	src="$1"
	dest="$2"
	tool="$3"
	timeout_sec="${4:-}"

	case "$src" in
		file://*)
			cp "${src#file://}" "$dest"
			return $?
			;;
	esac
	if [ -f "$src" ]; then
		cp "$src" "$dest"
		return $?
	fi

	wget_timeout=""
	if [ -n "$timeout_sec" ]; then
		wget_timeout="$timeout_sec"
		[ "$wget_timeout" -gt 10 ] 2>/dev/null && wget_timeout=10
	fi

	case "$tool" in
		curl|/system/bin/curl)
			if [ -n "$timeout_sec" ]; then
				"$tool" -fsSL --connect-timeout 6 -m "$timeout_sec" -o "$dest" "$src"
			else
				"$tool" -fsSL -o "$dest" "$src"
			fi
			;;
		wget|/system/bin/wget)
			if [ -n "$wget_timeout" ]; then
				flags_spec="$(probe_wget_timeout_flags "$tool")"
				set -- -q
				[ "${flags_spec%%:*}" = "1" ] && set -- "$@" -T "$wget_timeout"
				[ "${flags_spec#*:}" = "1" ] && set -- "$@" -t 1
				"$tool" "$@" -O "$dest" "$src"
			else
				"$tool" -q -O "$dest" "$src"
			fi
			;;
		busybox:*)
			bb="${tool#busybox:}"
			if [ -n "$wget_timeout" ]; then
				flags_spec="$(probe_wget_timeout_flags "$bb" wget)"
				set -- wget -q
				[ "${flags_spec%%:*}" = "1" ] && set -- "$@" -T "$wget_timeout"
				[ "${flags_spec#*:}" = "1" ] && set -- "$@" -t 1
				"$bb" "$@" -O "$dest" "$src"
			else
				"$bb" wget -q -O "$dest" "$src"
			fi
			;;
		toybox)
			if [ -n "$wget_timeout" ]; then
				flags_spec="$(probe_wget_timeout_flags toybox wget)"
				set -- wget -q
				[ "${flags_spec%%:*}" = "1" ] && set -- "$@" -T "$wget_timeout"
				[ "${flags_spec#*:}" = "1" ] && set -- "$@" -t 1
				toybox "$@" -O "$dest" "$src"
			else
				toybox wget -q -O "$dest" "$src"
			fi
			;;
		*)
			return 1
			;;
	esac
}

read_magic_hex() {
	f="$1"
	if command -v od >/dev/null 2>&1; then
		hex="$(dd if="$f" bs=1 count=4 2>/dev/null | od -A n -t x1 2>/dev/null | tr -d ' \t\r\n' || true)"
		if [ -n "$hex" ]; then
			printf '%s' "$hex"
			return 0
		fi
	fi
	if command -v hexdump >/dev/null 2>&1; then
		hex="$(dd if="$f" bs=1 count=4 2>/dev/null | hexdump -v -e '1/1 "%02x"' 2>/dev/null || true)"
		if [ -n "$hex" ]; then
			printf '%s' "$hex"
			return 0
		fi
	fi
	return 1
}

verify_elf_binary() {
	f="$1"
	[ -s "$f" ] || return 1
	sz="$(wc -c < "$f" 2>/dev/null | tr -d ' ' || echo 0)"
	case "$sz" in
		''|*[!0-9]*) sz=0 ;;
	esac
	[ "$sz" -ge 1024 ] || return 1
	if magic="$(read_magic_hex "$f")"; then
		[ "$magic" = "7f454c46" ]
		return $?
	fi
	head_txt="$(dd if="$f" bs=1 count=32 2>/dev/null | tr -d '\0' || true)"
	case "$head_txt" in
		""|'<'*|'#'*|'{'*) return 1 ;;
	esac
	return 0
}

verify_shell_script() {
	f="$1"
	[ -s "$f" ] || return 1
	first_line="$(sed -n '1p' "$f" 2>/dev/null | tr -d '\r' || true)"
	case "$first_line" in
		"#!"*) return 0 ;;
		*) return 1 ;;
	esac
}

json_quote() {
	val="$1"
	esc="$(printf '%s' "$val" | sed 's/\\/\\\\/g; s/"/\\"/g')"
	printf '"%s"' "$esc"
}

write_config_json() {
	cfg_file="$1"
	p_int="${POLL_INTERVAL:-5}"
	h_int="${HEARTBEAT_INTERVAL:-60}"
	case "$p_int" in ''|*[!0-9]*|0) p_int=5 ;; esac
	case "$h_int" in ''|*[!0-9]*|0) h_int=60 ;; esac
	mkdir -p "$(dirname "$cfg_file")"
	tmp_cfg="${cfg_file}.tmp.$$"
	cat > "$tmp_cfg" <<EOF
{
  "server": $(json_quote "$SERVER"),
  "api_key": $(json_quote "$API_KEY"),
  "name": $(json_quote "$DEVICE_NAME"),
  "device_id": $(json_quote "$DEVICE_ID"),
  "poll_interval": ${p_int},
  "heartbeat_interval": ${h_int},
  "log_level": "info"
}
EOF
	chmod 600 "$tmp_cfg" 2>/dev/null || true
	mv "$tmp_cfg" "$cfg_file"
}

stop_pid_file() {
	pf="$1"
	[ -f "$pf" ] || return 0
	old_pid="$(cat "$pf" 2>/dev/null | tr -d ' \t\r\n' || true)"
	case "$old_pid" in
		''|*[!0-9]*)
			rm -f "$pf"
			return 0
			;;
	esac
	if kill -0 "$old_pid" 2>/dev/null; then
		kill -TERM "$old_pid" 2>/dev/null || true
		sleep 1
		if kill -0 "$old_pid" 2>/dev/null; then
			kill -KILL "$old_pid" 2>/dev/null || true
		fi
	fi
	rm -f "$pf"
}

ARCH="$(detect_arch)"
DL_TOOL="$(probe_downloader)"
SH_BIN="$(resolve_shell_bin)"

if is_termux; then
	ANDROID_ENV="termux"
	PREFIX_DIR="${PREFIX:-/data/data/com.termux/files/usr}"
	HOME_DIR="${HOME:-/data/data/com.termux/files/home}"
	INSTALL_DIR="${CSLITE_INSTALL_DIR:-${PREFIX_DIR}/bin}"
	CONFIG_DIR="${CSLITE_CONFIG_DIR:-${HOME_DIR}/.config/cslite-agent}"
	BOOT_HOOK="${HOME_DIR}/.termux/boot/cslite-agent.sh"
else
	if [ -d /data/adb ] && [ -w /data/adb ]; then
		ANDROID_ENV="root-magisk"
		INSTALL_DIR="${CSLITE_INSTALL_DIR:-/data/adb/cslite-agent}"
		CONFIG_DIR="${CSLITE_CONFIG_DIR:-/data/adb/cslite-agent}"
		BOOT_HOOK="/data/adb/service.d/99-cslite-agent.sh"
	else
		ANDROID_ENV="adb-tmp"
		INSTALL_DIR="${CSLITE_INSTALL_DIR:-/data/local/tmp/cslite-agent}"
		CONFIG_DIR="${CSLITE_CONFIG_DIR:-/data/local/tmp/cslite-agent}"
		BOOT_HOOK=""
	fi
fi

resolve_tmp_dir() {
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
	cfg_tmp="${CONFIG_DIR}/tmp"
	mkdir -p "$cfg_tmp" 2>/dev/null || true
	printf '%s' "$cfg_tmp"
}

TMP_DIR="$(resolve_tmp_dir)"
CONFIG_FILE="${CONFIG_DIR}/config.json"
LOG_FILE="${CONFIG_DIR}/cslite-agent.log"
PID_FILE="${TMP_DIR}/cslite-agent.pid"
LITE_PID_FILE="${TMP_DIR}/cslite-agent-lite.pid"

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$TMP_DIR"
TMP_DL="${TMP_DIR}/cslite-dl.$$"
trap 'rm -f "$TMP_DL"' EXIT INT TERM

LOCAL_DIR=""
if [ -n "${0:-}" ] && [ -f "$0" ]; then
	LOCAL_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." 2>/dev/null && pwd || true)"
fi

INSTALLED_MODE=""
INSTALL_BIN=""

if [ "$LITE_MODE" -eq 0 ]; then
	TRY_URL="$BIN_URL"
	if [ -z "$TRY_URL" ]; then
		if [ "$VERSION" = "latest" ]; then
			TRY_URL="https://github.com/${REPO_DEFAULT}/releases/latest/download/cslite-agent-linux-${ARCH}"
		else
			TRY_URL="https://github.com/${REPO_DEFAULT}/releases/download/${VERSION}/cslite-agent-linux-${ARCH}"
		fi
	fi

	echo "Downloading cslite-agent (android/${ARCH}, env=${ANDROID_ENV}) from ${TRY_URL}..."
	if fetch_file "$TRY_URL" "$TMP_DL" "$DL_TOOL" 20 2>/dev/null && verify_elf_binary "$TMP_DL"; then
		INSTALL_BIN="${INSTALL_DIR}/cslite-agent"
		chmod 0755 "$TMP_DL"
		mv "$TMP_DL" "$INSTALL_BIN"
		INSTALLED_MODE="full"
	else
		echo "Go binary release not available at ${TRY_URL}; using server-hosted lite agent..."
		rm -f "$TMP_DL"
		LITE_MODE=1
	fi
fi

if [ "$LITE_MODE" -eq 1 ]; then
	if [ "$EXPLICIT_LITE" -eq 1 ] && [ -n "$BIN_URL" ]; then
		LITE_URL="$BIN_URL"
	else
		LITE_URL="${SERVER_BASE}/agent-lite.sh"
	fi

	echo "Downloading cslite-agent-lite from ${LITE_URL}..."
	if ! fetch_file "$LITE_URL" "$TMP_DL" "$DL_TOOL" 2>/dev/null || ! verify_shell_script "$TMP_DL"; then
		rm -f "$TMP_DL"
		if [ -n "$LOCAL_DIR" ] && [ -f "${LOCAL_DIR}/openwrt/cslite-agent-lite.sh" ]; then
			cp "${LOCAL_DIR}/openwrt/cslite-agent-lite.sh" "$TMP_DL"
		else
			FALLBACK_RAW="https://raw.githubusercontent.com/${REPO_DEFAULT}/main/agent/openwrt/cslite-agent-lite.sh"
			fetch_file "$FALLBACK_RAW" "$TMP_DL" "$DL_TOOL"
			verify_shell_script "$TMP_DL" || { echo "Error: downloaded lite script is invalid." >&2; exit 1; }
		fi
	fi

	# Ensure shebang points to a shell binary that exists on Android when /bin/sh is absent.
	if [ ! -x /bin/sh ] && [ -n "$SH_BIN" ]; then
		sed "1s|^#!/bin/sh|#!${SH_BIN}|" "$TMP_DL" > "${TMP_DL}.shebang"
		mv "${TMP_DL}.shebang" "$TMP_DL"
	fi

	INSTALL_BIN="${INSTALL_DIR}/cslite-agent-lite"
	chmod 0755 "$TMP_DL"
	mv "$TMP_DL" "$INSTALL_BIN"
	INSTALLED_MODE="lite"
fi

write_config_json "$CONFIG_FILE"

if [ "${CSLITE_SKIP_SERVICE_EXEC:-0}" = "1" ]; then
	echo "Installed ${INSTALLED_MODE} agent to ${INSTALL_BIN} (config: ${CONFIG_FILE}); skipped service start (CSLITE_SKIP_SERVICE_EXEC=1)."
	exit 0
fi

if [ -n "$BOOT_HOOK" ]; then
	mkdir -p "$(dirname "$BOOT_HOOK")"
	if [ "$ANDROID_ENV" = "termux" ]; then
		cat > "$BOOT_HOOK" <<EOF
#!${SH_BIN}
termux-wake-lock >/dev/null 2>&1 || true
export CSLITE_CONFIG_DIR="${CONFIG_DIR}"
if [ -f "${PID_FILE}" ] && kill -0 "\$(cat "${PID_FILE}" 2>/dev/null)" 2>/dev/null; then
	exit 0
fi
EOF
		if [ "$INSTALLED_MODE" = "lite" ]; then
			printf 'nohup "%s" "%s" run --config "%s" >"%s" 2>&1 </dev/null &\n' "$SH_BIN" "$INSTALL_BIN" "$CONFIG_FILE" "$LOG_FILE" >> "$BOOT_HOOK"
		else
			printf 'nohup "%s" run --config "%s" >"%s" 2>&1 </dev/null &\n' "$INSTALL_BIN" "$CONFIG_FILE" "$LOG_FILE" >> "$BOOT_HOOK"
		fi
		printf 'echo $! > "%s"\n' "$PID_FILE" >> "$BOOT_HOOK"
	else
		cat > "$BOOT_HOOK" <<EOF
#!${SH_BIN}
(
	i=0
	while [ "\$i" -lt 30 ]; do
		[ "\$(getprop sys.boot_completed 2>/dev/null)" = "1" ] && break
		sleep 2
		i=\$((i + 1))
	done
	export CSLITE_CONFIG_DIR="${CONFIG_DIR}"
	if [ -f "${PID_FILE}" ] && kill -0 "\$(cat "${PID_FILE}" 2>/dev/null)" 2>/dev/null; then
		exit 0
	fi
EOF
		if [ "$INSTALLED_MODE" = "lite" ]; then
			printf '\t"%s" "%s" run --config "%s" >"%s" 2>&1 </dev/null &\n' "$SH_BIN" "$INSTALL_BIN" "$CONFIG_FILE" "$LOG_FILE" >> "$BOOT_HOOK"
		else
			printf '\t"%s" run --config "%s" >"%s" 2>&1 </dev/null &\n' "$INSTALL_BIN" "$CONFIG_FILE" "$LOG_FILE" >> "$BOOT_HOOK"
		fi
		cat >> "$BOOT_HOOK" <<EOF
	echo \$! > "${PID_FILE}"
) &
EOF
	fi
	chmod 0755 "$BOOT_HOOK"
fi

stop_pid_file "$PID_FILE"
stop_pid_file "$LITE_PID_FILE"

export CSLITE_CONFIG_DIR="$CONFIG_DIR"
if [ "$INSTALLED_MODE" = "lite" ]; then
	if command -v nohup >/dev/null 2>&1; then
		nohup "$SH_BIN" "$INSTALL_BIN" run --config "$CONFIG_FILE" >"$LOG_FILE" 2>&1 </dev/null &
	else
		"$SH_BIN" "$INSTALL_BIN" run --config "$CONFIG_FILE" >"$LOG_FILE" 2>&1 </dev/null &
	fi
else
	if command -v nohup >/dev/null 2>&1; then
		nohup "$INSTALL_BIN" run --config "$CONFIG_FILE" >"$LOG_FILE" 2>&1 </dev/null &
	else
		"$INSTALL_BIN" run --config "$CONFIG_FILE" >"$LOG_FILE" 2>&1 </dev/null &
	fi
fi
AGENT_PID=$!
printf '%s\n' "$AGENT_PID" > "$PID_FILE"

sleep 1
if kill -0 "$AGENT_PID" 2>/dev/null; then
	echo "cslite-agent (${INSTALLED_MODE}, android/${ARCH}) started (pid=${AGENT_PID})"
else
	echo "Warning: agent process exited early; check log at ${LOG_FILE}" >&2
fi
echo "  Binary: ${INSTALL_BIN}"
echo "  Config: ${CONFIG_FILE}"
echo "  Log:    ${LOG_FILE}"
[ -n "$BOOT_HOOK" ] && echo "  Boot:   ${BOOT_HOOK}" || true
