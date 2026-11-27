start_nohup_fallback() {
	bin_path="$1"
	cfg_dir="$2"
	cfg_file="$3"
	is_lite="$4"
	sh_bin="$5"
	log_file="${cfg_dir}/cslite-agent.log"
	pid_file="${TMP_DIR}/cslite-agent.pid"
	lite_pid_file="${TMP_DIR}/cslite-agent-lite.pid"

	stop_pid_file "$pid_file"
	stop_pid_file "$lite_pid_file"

	export CSLITE_CONFIG_DIR="$cfg_dir"
	if command -v nohup >/dev/null 2>&1; then
		if [ "$is_lite" -eq 1 ]; then
			nohup "$sh_bin" "$bin_path" run --config "$cfg_file" >"$log_file" 2>&1 </dev/null &
		else
			nohup "$bin_path" run --config "$cfg_file" >"$log_file" 2>&1 </dev/null &
		fi
	else
		if [ "$is_lite" -eq 1 ]; then
			( trap '' HUP; exec "$sh_bin" "$bin_path" run --config "$cfg_file" ) >"$log_file" 2>&1 </dev/null &
		else
			( trap '' HUP; exec "$bin_path" run --config "$cfg_file" ) >"$log_file" 2>&1 </dev/null &
		fi
	fi
	ag_pid=$!
	printf '%s\n' "$ag_pid" > "$pid_file"
	echo "Started cslite-agent in background (pid=${ag_pid}, log=${log_file})"
}

is_openrc() {
	command -v rc-service >/dev/null 2>&1 || return 1
	command -v openrc-run >/dev/null 2>&1 || [ -x /sbin/openrc-run ]
}

openrc_shell_quote() {
	printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

install_openrc_service() {
	bin_path="$1"
	cfg_dir="$2"
	cfg_file="$3"
	is_lite="$4"
	sh_bin="$5"
	root_pfx="${CSLITE_OPENRC_ROOT:-}"
	init_dir="${root_pfx}/etc/init.d"
	init_path="${init_dir}/cslite-agent"
	log_file="${cfg_dir}/cslite-agent.log"
	mkdir -p "$init_dir" "$cfg_dir"
	if [ "$is_lite" -eq 1 ]; then
		cmd_exec="$sh_bin"
		cmd_args_inner="$(openrc_shell_quote "$bin_path") run --config $(openrc_shell_quote "$cfg_file")"
	else
		cmd_exec="$bin_path"
		cmd_args_inner="run --config $(openrc_shell_quote "$cfg_file")"
	fi
	cmd_exec_q="$(openrc_shell_quote "$cmd_exec")"
	cmd_args_q="$(openrc_shell_quote "$cmd_args_inner")"
	log_file_q="$(openrc_shell_quote "$log_file")"
	cat > "${init_path}.tmp.$$" <<EOF
#!/sbin/openrc-run
# CSLite Agent OpenRC init script

name="cslite-agent"
description="CSLite Cross-Platform Agent"
command=${cmd_exec_q}
command_args=${cmd_args_q}
command_background="yes"
pidfile="/run/cslite-agent.pid"
output_log=${log_file_q}
error_log=${log_file_q}

depend() {
	need net
	after firewall
}
EOF
	chmod 0755 "${init_path}.tmp.$$"
	mv "${init_path}.tmp.$$" "$init_path"
	if command -v rc-update >/dev/null 2>&1; then
		rc-update add cslite-agent default >/dev/null 2>&1 || true
	fi
	rc-service cslite-agent restart || rc-service cslite-agent start
	echo "Installed and started OpenRC service cslite-agent (${bin_path})"
}

OS="$(detect_os)"
ARCH="$(detect_arch)"
DL_TOOL="$(probe_downloader)"
TMP_DIR="$(pick_tmp_dir)"

if [ "$OS" = "android" ]; then
	install_android
	exit 0
fi

# On OpenWrt, automatically choose lite mode if flash space < 12 MB (12288 KB).
if [ "$OS" = "openwrt" ] && [ "$LITE_MODE" -eq 0 ]; then
	if df_out="$(df -k /overlay 2>/dev/null)" && [ -n "$df_out" ]; then
		:
	else
		df_out="$(df -k / 2>/dev/null || true)"
	fi
	avail_kb="$(printf '%s\n' "$df_out" | awk 'NR>1 { if (NF>=6 && $4~/^[0-9]+$/) { print $4; exit } else if (NF==5 && $3~/^[0-9]+$/) { print $3; exit } }' 2>/dev/null || true)"
	case "$avail_kb" in
		''|*[!0-9]*) ;;
		*)
			if [ "$avail_kb" -lt 12288 ]; then
				echo "OpenWrt free flash ${avail_kb} KB < 12288 KB; automatically selecting lite agent."
				LITE_MODE=1
			fi
			;;
	esac
fi

if [ -n "${CSLITE_INSTALL_DIR:-}" ]; then
	INSTALL_DIR="$CSLITE_INSTALL_DIR"
elif [ "$OS" = "openwrt" ]; then
	if is_writable_dir "/usr/bin"; then
		INSTALL_DIR="/usr/bin"
	elif is_writable_dir "/etc" || is_writable_dir "/etc/cslite-agent"; then
		INSTALL_DIR="/etc/cslite-agent"
		echo "OpenWrt /usr/bin is read-only; installing into ${INSTALL_DIR}"
	elif is_writable_dir "/data" || is_writable_dir "/data/cslite-agent"; then
		INSTALL_DIR="/data/cslite-agent"
		echo "OpenWrt /usr/bin is read-only; installing into ${INSTALL_DIR}"
	else
		INSTALL_DIR="$TMP_DIR"
		echo "OpenWrt flash directories are read-only; installing into ${INSTALL_DIR}"
	fi
elif [ "$USER_MODE" -eq 1 ] || [ "$(id -u)" -ne 0 ]; then
	INSTALL_DIR="${HOME:-$TMP_DIR}/.local/bin"
	USER_MODE=1
else
	INSTALL_DIR="/usr/local/bin"
fi

mkdir -p "$INSTALL_DIR"

TMP_DL="${TMP_DIR}/cslite-dl.$$"
trap 'rm -f "$TMP_DL"' EXIT INT TERM

INSTALLED_MODE=""
INSTALL_BIN=""

if [ "$LITE_MODE" -eq 0 ]; then
	BIN_OS="$OS"
	[ "$BIN_OS" = "openwrt" ] && BIN_OS="linux"
	[ "$BIN_OS" = "macos" ] && BIN_OS="darwin"

	TRY_URL="$BIN_URL"
	if [ -z "$TRY_URL" ]; then
		if [ "$VERSION" = "latest" ]; then
			TRY_URL="https://github.com/${REPO_DEFAULT}/releases/latest/download/cslite-agent-${BIN_OS}-${ARCH}"
		else
			TRY_URL="https://github.com/${REPO_DEFAULT}/releases/download/${VERSION}/cslite-agent-${BIN_OS}-${ARCH}"
		fi
	fi

	echo "Downloading cslite-agent (${OS}/${ARCH}) from ${TRY_URL}..."
	if fetch_file "$TRY_URL" "$TMP_DL" "$DL_TOOL" 20 2>/dev/null && verify_binary_magic "$TMP_DL" "$OS"; then
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
	fetch_lite_script "$TMP_DL"
	INSTALL_BIN="${INSTALL_DIR}/cslite-agent-lite"
	chmod 0755 "$TMP_DL"
	mv "$TMP_DL" "$INSTALL_BIN"
	INSTALLED_MODE="lite"
fi

SH_BIN="$(resolve_shell_bin)"

if [ -n "${CSLITE_CONFIG_DIR:-}" ]; then
	CFG_DIR="$CSLITE_CONFIG_DIR"
elif [ "$OS" = "openwrt" ]; then
	if is_writable_dir "/etc" || is_writable_dir "/etc/cslite-agent"; then
		CFG_DIR="/etc/cslite-agent"
	elif is_writable_dir "/data" || is_writable_dir "/data/cslite-agent"; then
		CFG_DIR="/data/cslite-agent"
	else
		CFG_DIR="${TMP_DIR}/cslite-agent"
	fi
elif [ "$USER_MODE" -eq 1 ] || [ "$(id -u)" -ne 0 ]; then
	if [ "$OS" = "macos" ] && [ "$INSTALLED_MODE" = "full" ]; then
		CFG_DIR="${HOME:-$TMP_DIR}/Library/Application Support/cslite-agent"
	else
		CFG_DIR="${HOME:-$TMP_DIR}/.config/cslite-agent"
	fi
else
	if [ "$OS" = "macos" ]; then
		CFG_DIR="/Library/Application Support/cslite-agent"
	else
		CFG_DIR="/etc/cslite-agent"
	fi
fi
CFG_FILE="${CFG_DIR}/config.json"

if [ "${CSLITE_SKIP_SERVICE_EXEC:-0}" = "1" ]; then
	if [ "$INSTALLED_MODE" = "lite" ]; then
		run_lite_save_config "$INSTALL_BIN" "$CFG_DIR" "$SH_BIN"
	else
		write_config_json "$CFG_FILE"
	fi
	echo "Installed ${INSTALLED_MODE} agent to ${INSTALL_BIN} (config: ${CFG_FILE}); skipped service exec."
	exit 0
fi

if [ "$INSTALLED_MODE" = "full" ]; then
	if [ "$OS" = "linux" ] && [ ! -d /run/systemd/system ] && ! command -v systemctl >/dev/null 2>&1; then
		set -- install --server "$SERVER" --key "$API_KEY"
		[ -n "$DEVICE_NAME" ] && set -- "$@" --name "$DEVICE_NAME"
		[ -n "$DEVICE_ID" ] && set -- "$@" --device-id "$DEVICE_ID"
		[ -n "$POLL_INTERVAL" ] && set -- "$@" --poll "$POLL_INTERVAL"
		[ -n "$HEARTBEAT_INTERVAL" ] && set -- "$@" --heartbeat "$HEARTBEAT_INTERVAL"
		[ "$USER_MODE" -eq 1 ] && set -- "$@" --user
		if is_openrc && [ "$USER_MODE" -eq 0 ]; then
			if "$INSTALL_BIN" "$@"; then
				exit 0
			fi
			write_config_json "$CFG_FILE"
			install_openrc_service "$INSTALL_BIN" "$CFG_DIR" "$CFG_FILE" 0 "$SH_BIN"
			exit 0
		fi
		write_config_json "$CFG_FILE"
		start_nohup_fallback "$INSTALL_BIN" "$CFG_DIR" "$CFG_FILE" 0 "$SH_BIN"
		exit 0
	fi

	set -- install --server "$SERVER" --key "$API_KEY"
	[ -n "$DEVICE_NAME" ] && set -- "$@" --name "$DEVICE_NAME"
	[ -n "$DEVICE_ID" ] && set -- "$@" --device-id "$DEVICE_ID"
	[ -n "$POLL_INTERVAL" ] && set -- "$@" --poll "$POLL_INTERVAL"
	[ -n "$HEARTBEAT_INTERVAL" ] && set -- "$@" --heartbeat "$HEARTBEAT_INTERVAL"
	[ "$USER_MODE" -eq 1 ] && set -- "$@" --user

	"$INSTALL_BIN" "$@"
	if [ "$OS" = "openwrt" ] && [ ! -x /etc/init.d/cslite-agent ]; then
		mkdir -p /etc/init.d
		if fetch_openwrt_init "${TMP_DIR}/cslite-init.$$"; then
			chmod 0755 "${TMP_DIR}/cslite-init.$$"
			mv "${TMP_DIR}/cslite-init.$$" /etc/init.d/cslite-agent
			/etc/init.d/cslite-agent enable
			/etc/init.d/cslite-agent restart || /etc/init.d/cslite-agent start
		fi
	fi
	exit 0
fi

# Lite agent installation & service setup across OpenWrt, Linux, macOS
case "$OS" in
	openwrt)
		mkdir -p "$CFG_DIR" 2>/dev/null || true
		INIT_DST="/etc/init.d/cslite-agent"
		if is_writable_dir "/etc/init.d" || is_writable_dir "/etc"; then
			mkdir -p /etc/init.d 2>/dev/null || true
			if fetch_openwrt_init "${TMP_DIR}/cslite-init.$$"; then
				chmod 0755 "${TMP_DIR}/cslite-init.$$"
				mv "${TMP_DIR}/cslite-init.$$" "$INIT_DST"
			else
				echo "Warning: could not download OpenWrt init script; saving config only." >&2
			fi
		fi
		set -- install --server "$SERVER" --key "$API_KEY"
		[ -n "$DEVICE_NAME" ] && set -- "$@" --name "$DEVICE_NAME"
		[ -n "$DEVICE_ID" ] && set -- "$@" --device-id "$DEVICE_ID"
		[ -n "$POLL_INTERVAL" ] && set -- "$@" --poll "$POLL_INTERVAL"
		[ -n "$HEARTBEAT_INTERVAL" ] && set -- "$@" --heartbeat "$HEARTBEAT_INTERVAL"
		CSLITE_CONFIG_DIR="$CFG_DIR" "$SH_BIN" "$INSTALL_BIN" "$@"
		if [ ! -x "$INIT_DST" ]; then
			start_nohup_fallback "$INSTALL_BIN" "$CFG_DIR" "$CFG_FILE" 1 "$SH_BIN"
		fi
		;;

	linux)
		run_lite_save_config "$INSTALL_BIN" "$CFG_DIR" "$SH_BIN"
		if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
			if [ "$USER_MODE" -eq 1 ]; then
				UNIT_PATH="${XDG_CONFIG_HOME:-${HOME:-$TMP_DIR}/.config}/systemd/user/cslite-agent.service"
				AFTER_LINE="default.target"
				WANTS_LINE=""
				WANTED_BY="default.target"
			else
				UNIT_PATH="/etc/systemd/system/cslite-agent.service"
				AFTER_LINE="network-online.target"
				WANTS_LINE="Wants=network-online.target"
				WANTED_BY="multi-user.target"
			fi
			mkdir -p "$(dirname "$UNIT_PATH")"
			cat > "${UNIT_PATH}.tmp.$$" <<EOF
[Unit]
Description=Cslite Lightweight Agent
After=${AFTER_LINE}
${WANTS_LINE}

[Service]
Type=simple
Environment=CSLITE_CONFIG_DIR=${CFG_DIR}
ExecStart=${INSTALL_BIN} run --config ${CFG_FILE}
Restart=always
RestartSec=5

[Install]
WantedBy=${WANTED_BY}
EOF
			mv "${UNIT_PATH}.tmp.$$" "$UNIT_PATH"
			if [ "$USER_MODE" -eq 1 ]; then
				if systemctl --user daemon-reload && systemctl --user enable cslite-agent && systemctl --user restart cslite-agent; then
					echo "Installed and started user systemd service cslite-agent (${INSTALL_BIN})"
					exit 0
				fi
				echo "systemd --user unavailable; falling back to background process..."
				start_nohup_fallback "$INSTALL_BIN" "$CFG_DIR" "$CFG_FILE" 1 "$SH_BIN"
			else
				systemctl daemon-reload
				systemctl enable cslite-agent
				systemctl restart cslite-agent
				echo "Installed and started systemd service cslite-agent (${INSTALL_BIN})"
			fi
		elif is_openrc && [ "$USER_MODE" -eq 0 ]; then
			install_openrc_service "$INSTALL_BIN" "$CFG_DIR" "$CFG_FILE" 1 "$SH_BIN"
		else
			start_nohup_fallback "$INSTALL_BIN" "$CFG_DIR" "$CFG_FILE" 1 "$SH_BIN"
		fi
		;;

	macos)
		run_lite_save_config "$INSTALL_BIN" "$CFG_DIR" "$SH_BIN"
		LABEL="com.cslite.agent"
		if [ "$USER_MODE" -eq 1 ]; then
			PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
			LOG_PATH="${HOME}/Library/Logs/cslite-agent.log"
			DOMAIN="gui/$(id -u)"
		else
			PLIST_PATH="/Library/LaunchDaemons/${LABEL}.plist"
			LOG_PATH="/Library/Logs/cslite-agent.log"
			DOMAIN="system"
		fi
		mkdir -p "$(dirname "$PLIST_PATH")" "$(dirname "$LOG_PATH")"
		cat > "${PLIST_PATH}.tmp.$$" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>CSLITE_CONFIG_DIR</key>
		<string>$(xml_escape "$CFG_DIR")</string>
		<key>PATH</key>
		<string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
	<key>ProgramArguments</key>
	<array>
		<string>$(xml_escape "$SH_BIN")</string>
		<string>$(xml_escape "$INSTALL_BIN")</string>
		<string>run</string>
		<string>--config</string>
		<string>$(xml_escape "$CFG_FILE")</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$(xml_escape "$LOG_PATH")</string>
	<key>StandardErrorPath</key>
	<string>$(xml_escape "$LOG_PATH")</string>
</dict>
</plist>
EOF
		mv "${PLIST_PATH}.tmp.$$" "$PLIST_PATH"
		launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
		if ! launchctl bootstrap "$DOMAIN" "$PLIST_PATH" 2>/dev/null; then
			launchctl load -w "$PLIST_PATH"
		fi
		launchctl kickstart -k "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
		echo "Installed and started launchd service ${LABEL} (${INSTALL_BIN})"
		;;
esac
