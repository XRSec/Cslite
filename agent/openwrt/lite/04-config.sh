sanitize_config_field() {
	val="${1:-}"
	trimmed="$val"
	while :; do
		case "$trimmed" in
			' '*|'	'*) trimmed="${trimmed#?}" ;;
			*) break ;;
		esac
	done
	case "$trimmed" in
		\{*) printf '' ;;
		*) printf '%s' "$val" ;;
	esac
}

is_pos_int() {
	case "${1:-}" in
		''|0*|*[!0-9]*) return 1 ;;
		*) return 0 ;;
	esac
}

apply_server_intervals() {
	srv_hb="${1:-}"
	srv_poll="${2:-}"
	if [ "${HB_EXPLICIT:-0}" -eq 0 ] && is_pos_int "$srv_hb"; then
		HEARTBEAT_INTERVAL="$srv_hb"
	fi
	if [ "${POLL_EXPLICIT:-0}" -eq 0 ] && is_pos_int "$srv_poll"; then
		POLL_INTERVAL="$srv_poll"
	fi
}

load_config() {
	cli_server="$SERVER"
	cli_key="$API_KEY"
	cli_name="$DEVICE_NAME"
	cli_dev="$DEVICE_ID"
	cli_ua="$USER_AGENT"
	cli_ref="$REFERER"
	cli_poll="$POLL_INTERVAL"
	cli_hb="$HEARTBEAT_INTERVAL"
	cli_log="$LOG_LEVEL"

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

	if [ "${IGNORE_EXISTING_CONFIG:-0}" -ne 1 ] && [ -f "$CONFIG_FILE" ]; then
		cfg_raw="$(cat "$CONFIG_FILE" 2>/dev/null || true)"
		if [ -n "$cfg_raw" ]; then
			SERVER="$(sanitize_config_field "$(json_get "$cfg_raw" "server")")"
			API_KEY="$(sanitize_config_field "$(json_get "$cfg_raw" "api_key")")"
			DEVICE_NAME="$(sanitize_config_field "$(json_get "$cfg_raw" "name")")"
			DEVICE_ID="$(sanitize_config_field "$(json_get "$cfg_raw" "device_id")")"
			USER_AGENT="$(sanitize_config_field "$(json_get "$cfg_raw" "user_agent")")"
			REFERER="$(sanitize_config_field "$(json_get "$cfg_raw" "referer")")"
			POLL_INTERVAL="$(sanitize_config_field "$(json_get "$cfg_raw" "poll_interval")")"
			HEARTBEAT_INTERVAL="$(sanitize_config_field "$(json_get "$cfg_raw" "heartbeat_interval")")"
			LOG_LEVEL="$(sanitize_config_field "$(json_get "$cfg_raw" "log_level")")"
			if is_pos_int "$POLL_INTERVAL" && [ "$POLL_INTERVAL" != "5" ]; then
				POLL_EXPLICIT=1
			fi
			if is_pos_int "$HEARTBEAT_INTERVAL" && [ "$HEARTBEAT_INTERVAL" != "60" ]; then
				HB_EXPLICIT=1
			fi
		fi
	fi

	# Env vars override config.json
	[ -n "${CSLITE_SERVER:-}" ] && SERVER="$CSLITE_SERVER"
	[ -z "$SERVER" ] && [ -n "${AGENT_SERVER:-}" ] && SERVER="$AGENT_SERVER"

	[ -n "${CSLITE_API_KEY:-}" ] && API_KEY="$CSLITE_API_KEY"
	[ -z "$API_KEY" ] && [ -n "${AGENT_API_KEY:-}" ] && API_KEY="$AGENT_API_KEY"
	[ -z "$API_KEY" ] && [ -n "${AGENT_KEY:-}" ] && API_KEY="$AGENT_KEY"

	[ -n "${CSLITE_NAME:-}" ] && DEVICE_NAME="$CSLITE_NAME"
	[ -z "$DEVICE_NAME" ] && [ -n "${AGENT_NAME:-}" ] && DEVICE_NAME="$AGENT_NAME"

	[ -n "${CSLITE_DEVICE_ID:-}" ] && DEVICE_ID="$CSLITE_DEVICE_ID"
	[ -z "$DEVICE_ID" ] && [ -n "${AGENT_DEVICE_ID:-}" ] && DEVICE_ID="$AGENT_DEVICE_ID"

	[ -n "${CSLITE_USER_AGENT:-}" ] && USER_AGENT="$CSLITE_USER_AGENT"
	[ -n "${CSLITE_REFERER:-}" ] && REFERER="$CSLITE_REFERER"

	if [ -n "${CSLITE_POLL_INTERVAL:-}" ]; then
		POLL_INTERVAL="$CSLITE_POLL_INTERVAL"
		is_pos_int "$POLL_INTERVAL" && POLL_EXPLICIT=1
	fi
	if [ -n "${CSLITE_HEARTBEAT_INTERVAL:-}" ]; then
		HEARTBEAT_INTERVAL="$CSLITE_HEARTBEAT_INTERVAL"
		is_pos_int "$HEARTBEAT_INTERVAL" && HB_EXPLICIT=1
	elif [ -z "$HEARTBEAT_INTERVAL" ] && [ -n "${AGENT_INTERVAL:-}" ]; then
		HEARTBEAT_INTERVAL="$AGENT_INTERVAL"
		is_pos_int "$HEARTBEAT_INTERVAL" && HB_EXPLICIT=1
	fi
	[ -n "${CSLITE_LOG_LEVEL:-}" ] && LOG_LEVEL="$CSLITE_LOG_LEVEL"

	# CLI flags take highest precedence
	[ -n "$cli_server" ] && SERVER="$cli_server"
	[ -n "$cli_key" ] && API_KEY="$cli_key"
	[ -n "$cli_name" ] && DEVICE_NAME="$cli_name"
	[ -n "$cli_dev" ] && DEVICE_ID="$cli_dev"
	[ -n "$cli_ua" ] && USER_AGENT="$cli_ua"
	[ -n "$cli_ref" ] && REFERER="$cli_ref"
	if [ -n "$cli_poll" ]; then
		POLL_INTERVAL="$cli_poll"
		is_pos_int "$POLL_INTERVAL" && POLL_EXPLICIT=1
	fi
	if [ -n "$cli_hb" ]; then
		HEARTBEAT_INTERVAL="$cli_hb"
		is_pos_int "$HEARTBEAT_INTERVAL" && HB_EXPLICIT=1
	fi
	[ -n "$cli_log" ] && LOG_LEVEL="$cli_log"

	if ! is_pos_int "$POLL_INTERVAL"; then
		POLL_INTERVAL=5
		POLL_EXPLICIT=0
	fi
	if ! is_pos_int "$HEARTBEAT_INTERVAL"; then
		HEARTBEAT_INTERVAL=60
		HB_EXPLICIT=0
	fi
	LOG_LEVEL="${LOG_LEVEL:-info}"
}

save_config() {
	mkdir -p "$(dirname "$CONFIG_FILE")"
	tmp_cfg="${CONFIG_FILE}.tmp.$$"
	case "$POLL_INTERVAL" in
		''|0*|*[!0-9]*) POLL_INTERVAL=5 ;;
	esac
	case "$HEARTBEAT_INTERVAL" in
		''|0*|*[!0-9]*) HEARTBEAT_INTERVAL=60 ;;
	esac
	extra_hdrs=""
	[ -n "$USER_AGENT" ] && extra_hdrs="${extra_hdrs}  \"user_agent\": $(json_quote "$USER_AGENT"),
"
	[ -n "$REFERER" ] && extra_hdrs="${extra_hdrs}  \"referer\": $(json_quote "$REFERER"),
"
	cat > "$tmp_cfg" <<EOF
{
  "server": $(json_quote "$SERVER"),
  "api_key": $(json_quote "$API_KEY"),
  "name": $(json_quote "$DEVICE_NAME"),
  "device_id": $(json_quote "$DEVICE_ID"),
${extra_hdrs}  "poll_interval": ${POLL_INTERVAL},
  "heartbeat_interval": ${HEARTBEAT_INTERVAL},
  "log_level": $(json_quote "${LOG_LEVEL:-info}")
}
EOF
	chmod 600 "$tmp_cfg" 2>/dev/null || true
	mv "$tmp_cfg" "$CONFIG_FILE"
}

save_state() {
	mkdir -p "$(dirname "$STATE_FILE")"
	tmp_st="${STATE_FILE}.tmp.$$"
	cat > "$tmp_st" <<EOF
{
  "agent_id": $(json_quote "$AGENT_ID"),
  "device_id": $(json_quote "$BOUND_DEVICE_ID"),
  "server_url": $(json_quote "$BASE_URL")
}
EOF
	chmod 600 "$tmp_st" 2>/dev/null || true
	mv "$tmp_st" "$STATE_FILE"
}

is_valid_state_file() {
	[ -f "$1" ] || return 1
	st_raw="$(cat "$1" 2>/dev/null || true)"
	[ -n "$st_raw" ] || return 1
	case "$st_raw" in
		*'{ "v":'*|*'{"v":'*) return 1 ;;
	esac
	compact_st="$(printf '%s' "$st_raw" | tr -d ' \t\r\n')"
	case "$compact_st" in
		\{*\}) ;;
		*) return 1 ;;
	esac
	if command -v jsonfilter >/dev/null 2>&1; then
		printf '%s' "$st_raw" | jsonfilter -e '@.agent_id' >/dev/null 2>&1 || return 1
	fi
	st_agent="$(json_get "$st_raw" "agent_id")"
	st_dev="$(json_get "$st_raw" "device_id")"
	st_url="$(json_get "$st_raw" "server_url")"
	case "$st_agent" in
		''|\{*) return 1 ;;
	esac
	case "$st_dev" in
		\{*) return 1 ;;
	esac
	case "$st_url" in
		\{*) return 1 ;;
	esac
	return 0
}

load_state() {
	is_valid_state_file "$STATE_FILE" || return 1
	st_raw="$(cat "$STATE_FILE" 2>/dev/null || true)"
	[ -n "$st_raw" ] || return 1
	st_agent="$(json_get "$st_raw" "agent_id")"
	st_dev="$(json_get "$st_raw" "device_id")"
	st_url="$(json_get "$st_raw" "server_url")"
	if [ -z "$st_agent" ] || [ -z "$st_dev" ] || [ "$st_url" != "$BASE_URL" ]; then
		return 1
	fi
	if [ -n "$DEVICE_ID" ] && [ "$st_dev" != "$DEVICE_ID" ]; then
		return 1
	fi
	AGENT_ID="$st_agent"
	BOUND_DEVICE_ID="$st_dev"
	return 0
}

register_agent() {
	host="$(hostname 2>/dev/null || uname -n 2>/dev/null || echo openwrt)"
	dname="${DEVICE_NAME:-$host}"
	plat="$(detect_platform)"
	arch="$(detect_arch)"
	osver="$(detect_os_version)"

	extra_dev=""
	[ -n "$DEVICE_ID" ] && extra_dev=",\"device_id\":$(json_quote "$DEVICE_ID")"

	payload="{\"name\":$(json_quote "$dname"),\"platform\":$(json_quote "$plat"),\"arch\":$(json_quote "$arch"),\"os_version\":$(json_quote "$osver"),\"hostname\":$(json_quote "$host"),\"version\":$(json_quote "$VERSION"),\"api_key\":$(json_quote "$API_KEY")${extra_dev}}"

	resp="$(http_request POST "/agent/register" "$payload")" || return 1
	code="$(json_get "$resp" "code")"
	if [ "$code" != "20000" ]; then
		msg="$(json_get "$resp" "message")"
		log_msg ERROR "register failed (code=${code:-unknown}): ${msg:-$resp}"
		return 1
	fi

	AGENT_ID="$(json_get "$resp" "data.agent_id")"
	BOUND_DEVICE_ID="$(json_get "$resp" "data.device_id")"
	if [ -z "$AGENT_ID" ] || [ -z "$BOUND_DEVICE_ID" ]; then
		log_msg ERROR "register response missing agent_id or device_id"
		return 1
	fi
	apply_server_intervals "$(json_get "$resp" "data.heartbeat_interval")" "$(json_get "$resp" "data.poll_interval")"
	save_state
	log_msg INFO "registered agent_id=$AGENT_ID device_id=$BOUND_DEVICE_ID"
	return 0
}

ensure_registered() {
	if load_state; then
		log_msg DEBUG "loaded state agent_id=$AGENT_ID device_id=$BOUND_DEVICE_ID"
		return 0
	fi
	register_agent
}

