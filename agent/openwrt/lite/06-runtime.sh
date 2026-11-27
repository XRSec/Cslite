kill_tree() {
	target_pid="$1"
	sig="${2:-TERM}"
	if command -v pgrep >/dev/null 2>&1; then
		for child in $(pgrep -P "$target_pid" 2>/dev/null); do
			kill_tree "$child" "$sig"
		done
	elif [ -d /proc ]; then
		for pdir in /proc/[0-9]*; do
			[ -r "$pdir/stat" ] || continue
			ppid="$(run_awk '{print $4}' "$pdir/stat" 2>/dev/null || true)"
			if [ "$ppid" = "$target_pid" ]; then
				cpid="${pdir##*/}"
				kill_tree "$cpid" "$sig"
			fi
		done
	fi
	kill -"$sig" "$target_pid" 2>/dev/null || true
}

resolve_default_shell() {
	if [ -x /bin/sh ]; then
		printf '/bin/sh'
	elif [ -n "${PREFIX:-}" ] && [ -x "${PREFIX%/}/bin/sh" ]; then
		printf '%s/bin/sh' "${PREFIX%/}"
	elif [ -x /system/bin/sh ]; then
		printf '/system/bin/sh'
	elif command -v sh >/dev/null 2>&1; then
		command -v sh
	else
		printf '/bin/sh'
	fi
}

execute_task_and_report() {
	resp="$1"
	exec_id="$(json_get "$resp" "data.commands.0.execution_id")"
	[ -n "$exec_id" ] || return 0

	result_id="$(json_get "$resp" "data.commands.0.result_id")"
	cmd_id="$(json_get "$resp" "data.commands.0.command_id")"
	content="$(json_get "$resp" "data.commands.0.content")"
	timeout_sec="$(json_get "$resp" "data.commands.0.timeout")"
	req_shell="$(json_get "$resp" "data.commands.0.shell")"

	case "$timeout_sec" in
		''|*[!0-9]*|0) timeout_sec=600 ;;
	esac

	shell_bin="$(resolve_default_shell)"
	case "$req_shell" in
		bash) command -v bash >/dev/null 2>&1 && shell_bin="$(command -v bash)" ;;
		ash) command -v ash >/dev/null 2>&1 && shell_bin="$(command -v ash)" ;;
	esac

	mkdir -p "$TMP_DIR" 2>/dev/null || true
	work_dir="${TMP_DIR}/cslite-exec.$$"
	mkdir -p "$work_dir"
	out_file="$work_dir/out"
	env_file="$work_dir/env.sh"
	to_flag="$work_dir/timeout"

	: > "$env_file"
	json_get_env_lines "$resp" "data.commands.0.env_vars" | while IFS='=' read -r ek ev; do
		[ -n "$ek" ] || continue
		case "$ek" in
			*[!A-Za-z0-9_]*|[0-9]*) continue ;;
		esac
		esc_ev="$(printf '%s' "$ev" | sed "s/'/'\\\\''/g")"
		printf "export %s='%s'\n" "$ek" "$esc_ev" >> "$env_file"
	done

	log_msg INFO "executing cmd_id=$cmd_id execution_id=$exec_id timeout=${timeout_sec}s"

	(
		if [ -s "$env_file" ]; then
			. "$env_file"
		fi
		exec "$shell_bin" -c "$content"
	) > "$out_file" 2>&1 &
	cmd_pid=$!

	# Pure POSIX watchdog (no GNU timeout required).
	(
		sleep "$timeout_sec" &
		spid=$!
		trap 'kill -KILL "$spid" 2>/dev/null; exit 0' TERM INT
		wait "$spid" 2>/dev/null
		: > "$to_flag"
		kill_tree "$cmd_pid" TERM
		sleep 1
		kill_tree "$cmd_pid" KILL
	) >/dev/null 2>&1 &
	wd_pid=$!

	wait "$cmd_pid" 2>/dev/null
	rc=$?

	kill -TERM "$wd_pid" 2>/dev/null || true
	wait "$wd_pid" 2>/dev/null || true

	status="completed"
	if [ -f "$to_flag" ]; then
		status="timeout"
		rc=-1
	elif [ "$rc" -ne 0 ]; then
		status="failed"
	fi

	# Truncate safely to 64 KiB for BusyBox / uclient-fetch ARG_MAX safety.
	raw_size=$(wc -c < "$out_file" 2>/dev/null | tr -d ' ')
	if [ "${raw_size:-0}" -gt 65536 ]; then
		dd if="$out_file" of="$out_file.trunc" bs=1024 count=64 2>/dev/null || head -c 65536 "$out_file" > "$out_file.trunc"
		printf '\n... (truncated)\n' >> "$out_file.trunc"
		mv "$out_file.trunc" "$out_file"
	fi

	esc_output="$(json_escape_stdin < "$out_file")"
	rm -rf "$work_dir"

	comp_at="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
	extra_rid=""
	[ -n "$result_id" ] && extra_rid="\"result_id\":$(json_quote "$result_id"),"

	res_payload="{${extra_rid}\"execution_id\":$(json_quote "$exec_id"),\"device_id\":$(json_quote "$BOUND_DEVICE_ID"),\"api_key\":$(json_quote "$API_KEY"),\"status\":$(json_quote "$status"),\"exit_code\":${rc},\"output\":\"${esc_output}\",\"completed_at\":$(json_quote "$comp_at")}"

	attempt=0
	for delay in 1 2 4; do
		attempt=$((attempt + 1))
		rep_resp="$(http_request POST "/agent/result" "$res_payload" || true)"
		rep_code="$(json_get "$rep_resp" "code")"
		if [ "$rep_code" = "20000" ]; then
			log_msg INFO "reported execution_id=$exec_id status=$status exit_code=$rc"
			return 0
		fi
		sleep "$delay"
	done
	log_msg ERROR "failed to report execution_id=$exec_id after $attempt attempts"
	return 1
}

fetch_commands_raw() {
	include_metrics="${1:-${POLL_INCLUDE_METRICS:-0}}"
	pre_metrics_json="${2:-}"
	if [ "$include_metrics" = "1" ]; then
		if [ -z "$pre_metrics_json" ]; then
			collect_metrics
			pre_metrics_json="$METRICS_JSON"
		fi
		host="$(hostname 2>/dev/null || uname -n 2>/dev/null || true)"
		osver="$(detect_os_version)"
		ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
		poll_body="{\"agent_id\":$(json_quote "$AGENT_ID"),\"api_key\":$(json_quote "$API_KEY"),\"limit\":1,\"metrics\":${pre_metrics_json},\"version\":$(json_quote "$VERSION"),\"os_version\":$(json_quote "$osver"),\"hostname\":$(json_quote "$host"),\"timestamp\":$(json_quote "$ts")}"
	else
		poll_body="{\"agent_id\":$(json_quote "$AGENT_ID"),\"api_key\":$(json_quote "$API_KEY"),\"limit\":1}"
	fi
	http_request POST "/agent/commands" "$poll_body"
}

poll_once() {
	include_metrics="${1:-${POLL_INCLUDE_METRICS:-0}}"
	poll_metrics_json=""
	if [ "$include_metrics" = "1" ]; then
		collect_metrics
		poll_metrics_json="$METRICS_JSON"
	fi
	resp="$(fetch_commands_raw "$include_metrics" "$poll_metrics_json")" || return 1

	code="$(json_get "$resp" "code")"
	if [ "$code" = "40010" ]; then
		log_msg WARN "poll returned 40010; re-registering"
		rm -f "$STATE_FILE"
		register_agent || return 1
		resp="$(fetch_commands_raw "$include_metrics" "$poll_metrics_json")" || return 1
		code="$(json_get "$resp" "code")"
	fi
	if [ "$code" != "20000" ]; then
		log_msg ERROR "poll failed (code=${code:-unknown}): $resp"
		return 1
	fi

	apply_server_intervals "$(json_get "$resp" "data.next_heartbeat")" "$(json_get "$resp" "data.poll_interval")"
	if [ "$include_metrics" = "1" ]; then
		LAST_HB_SYNC="$(date +%s 2>/dev/null || echo 0)"
	fi

	exec_id="$(json_get "$resp" "data.commands.0.execution_id")"
	if [ -n "$exec_id" ]; then
		execute_task_and_report "$resp" || return 1
		return 2
	fi
	return 0
}

parse_flags() {
	cfg_flag_set=0
	while [ $# -gt 0 ]; do
		case "$1" in
			--server) SERVER="$2"; shift 2 ;;
			--key|--apikey|--api-key) API_KEY="$2"; shift 2 ;;
			--name) DEVICE_NAME="$2"; shift 2 ;;
			--device-id) DEVICE_ID="$2"; shift 2 ;;
			--user-agent) USER_AGENT="$2"; shift 2 ;;
			--referer) REFERER="$2"; shift 2 ;;
			--config) CONFIG_FILE="$2"; cfg_flag_set=1; shift 2 ;;
			--poll) POLL_INTERVAL="$2"; shift 2 ;;
			--heartbeat) HEARTBEAT_INTERVAL="$2"; shift 2 ;;
			--log-level) LOG_LEVEL="$2"; shift 2 ;;
			--user) USER_MODE=1; shift ;;
			--once) ONCE_MODE=1; shift ;;
			--purge) PURGE_MODE=1; shift ;;
			*) shift ;;
		esac
	done

	if [ "$cfg_flag_set" -eq 1 ] && [ -z "${CSLITE_CONFIG_DIR:-}" ]; then
		CONFIG_DIR="$(dirname "$CONFIG_FILE")"
		if [ -z "${CSLITE_STATE_FILE:-}" ]; then
			STATE_FILE="${CONFIG_DIR}/state.json"
		fi
		TMP_DIR="$(pick_tmp_dir)"
		PID_FILE="${TMP_DIR}/cslite-agent-lite.pid"
	elif [ "$USER_MODE" -eq 1 ] && [ -z "${CSLITE_CONFIG_DIR:-}" ] && [ -z "${CSLITE_CONFIG:-}" ] && [ "$cfg_flag_set" -eq 0 ]; then
		CONFIG_DIR="$(default_config_dir)"
		CONFIG_FILE="${CONFIG_DIR}/config.json"
		if [ -z "${CSLITE_STATE_FILE:-}" ]; then
			STATE_FILE="${CONFIG_DIR}/state.json"
		fi
		TMP_DIR="$(pick_tmp_dir)"
		PID_FILE="${TMP_DIR}/cslite-agent-lite.pid"
	fi
}

sleep_interruptible() {
	sleep "$1" &
	SLEEP_PID=$!
	wait "$SLEEP_PID" 2>/dev/null || true
	SLEEP_PID=""
}

cmd_run() {
	parse_flags "$@"
	load_config

	if [ -z "$SERVER" ] || [ -z "$API_KEY" ]; then
		log_msg ERROR "server URL and API key are required"
		exit 1
	fi
	if ! probe_http_client; then
		log_msg ERROR "no HTTP client found (need curl, wget, uclient-fetch, or openssl)"
		exit 1
	fi

	normalize_server_url "$SERVER"

	if [ "$ONCE_MODE" -eq 1 ]; then
		ensure_registered || exit 1
		send_heartbeat || exit 1
		poll_once
		prc=$?
		case "$prc" in
			0|2) return 0 ;;
			*) return "$prc" ;;
		esac
	fi

	mkdir -p "$TMP_DIR" 2>/dev/null || true
	trap 'log_msg INFO "shutting down"; [ -n "${SLEEP_PID:-}" ] && kill -TERM "$SLEEP_PID" 2>/dev/null || true; rm -f "$PID_FILE"; exit 0' TERM INT
	printf '%s\n' "$$" > "$PID_FILE" 2>/dev/null || true

	while ! ensure_registered; do
		sleep_interruptible 5
	done
	if send_heartbeat; then
		last_hb=$(date +%s 2>/dev/null || echo 0)
	else
		last_hb=0
	fi
	fast_until=0

	while :; do
		now=$(date +%s 2>/dev/null || echo 0)
		need_metrics=0
		if [ "$last_hb" -eq 0 ] || [ $((now - last_hb)) -ge "${HEARTBEAT_INTERVAL:-60}" ]; then
			need_metrics=1
		fi

		poll_once "$need_metrics"
		prc=$?
		case "$prc" in
			0|2)
				if [ "$need_metrics" -eq 1 ]; then
					last_hb="$now"
					LAST_HB_SYNC="$now"
				fi
				if [ "$prc" -eq 2 ]; then
					fast_until=$((now + 15))
				fi
				;;
			*)
				if [ "$need_metrics" -eq 1 ]; then
					if send_heartbeat; then
						last_hb="$now"
					fi
				fi
				;;
		esac

		if [ "$now" -lt "$fast_until" ]; then
			sleep_interruptible 1
		else
			sleep_interruptible "${POLL_INTERVAL:-5}"
		fi
	done
}

cmd_install() {
	IGNORE_EXISTING_CONFIG=0
	parse_flags "$@"
	if [ -n "$SERVER" ] && [ -n "$API_KEY" ]; then
		IGNORE_EXISTING_CONFIG=1
	fi
	load_config
	if [ -z "$SERVER" ] || [ -z "$API_KEY" ]; then
		log_msg ERROR "--server and --key are required"
		exit 1
	fi
	if [ -f "$STATE_FILE" ] && ! is_valid_state_file "$STATE_FILE"; then
		log_msg WARN "removing corrupt state file $STATE_FILE"
		rm -f "$STATE_FILE"
	fi
	save_config
	if [ "${CSLITE_SKIP_SERVICE_EXEC:-0}" != "1" ] && [ -x "$INIT_SCRIPT" ] && [ "$(detect_platform)" = "openwrt" ]; then
		"$INIT_SCRIPT" enable
		"$INIT_SCRIPT" restart || "$INIT_SCRIPT" start
		echo "Installed and started $INIT_SCRIPT using config $CONFIG_FILE"
	else
		echo "Saved config to $CONFIG_FILE"
	fi
}

cmd_uninstall() {
	parse_flags "$@"
	if [ -x "$INIT_SCRIPT" ]; then
		"$INIT_SCRIPT" stop 2>/dev/null || true
		"$INIT_SCRIPT" disable 2>/dev/null || true
	fi
	if [ "$PURGE_MODE" -eq 1 ]; then
		rm -f "$CONFIG_FILE" "$STATE_FILE" "$PID_FILE"
		rmdir "$CONFIG_DIR" 2>/dev/null || true
	fi
	echo "Uninstalled cslite-agent-lite"
}

cmd_service() {
	action="$1"
	if [ -x "$INIT_SCRIPT" ]; then
		"$INIT_SCRIPT" "$action"
		return $?
	fi
	case "$action" in
		status)
			if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
				echo "running (pid $(cat "$PID_FILE"))"
			else
				echo "stopped"
			fi
			;;
		stop)
			[ -f "$PID_FILE" ] && kill -TERM "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null || true
			rm -f "$PID_FILE"
			;;
		*)
			log_msg ERROR "init script $INIT_SCRIPT not installed"
			exit 1
			;;
	esac
}

cmd_version() {
	probe_http_client || HTTP_CLIENT="none"
	json_tool="awk"
	command -v jsonfilter >/dev/null 2>&1 && json_tool="jsonfilter"
	printf 'cslite-agent-lite %s\n' "$VERSION"
	printf 'os/arch:     %s/%s\n' "$(detect_platform)" "$(detect_arch)"
	printf 'http_client: %s\n' "$HTTP_CLIENT"
	printf 'json_tool:   %s\n' "$json_tool"
}

SUBCMD="${1:-help}"
[ $# -gt 0 ] && shift
case "$SUBCMD" in
	run) cmd_run "$@" ;;
	install) cmd_install "$@" ;;
	uninstall) cmd_uninstall "$@" ;;
	start|stop|restart|status) cmd_service "$SUBCMD" ;;
	version|-v|--version) cmd_version ;;
	help|-h|--help)
		cat <<EOF
cslite-agent-lite $VERSION — BusyBox POSIX agent

Usage:
  cslite-agent-lite <run|install|uninstall|start|stop|restart|status|version> [options]
EOF
		;;
	*)
		echo "Unknown command: $SUBCMD" >&2
		exit 2
		;;
esac
