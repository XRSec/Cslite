pick_tmp_dir() {
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
	if [ -n "${HOME:-}" ] && is_writable_dir "$HOME"; then
		printf '%s' "${HOME%/}"
		return 0
	fi
	printf '.'
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

verify_binary_magic() {
	f="$1"
	os_kind="$2"
	[ -s "$f" ] || return 1
	sz="$(wc -c < "$f" 2>/dev/null | tr -d ' ' || echo 0)"
	case "$sz" in
		''|*[!0-9]*) sz=0 ;;
	esac
	[ "$sz" -ge 1024 ] || return 1

	if magic="$(read_magic_hex "$f")"; then
		case "$os_kind" in
			macos|darwin)
				case "$magic" in
					cffaedfe|cefaedfe|cafebabe|feedfacf|feedface) return 0 ;;
					*) return 1 ;;
				esac
				;;
			*)
				[ "$magic" = "7f454c46" ]
				return $?
				;;
		esac
	fi

	# Fallback sanity check when neither od nor hexdump exists.
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
	esc="$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
	printf '"%s"' "$esc"
}

xml_escape() {
	printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'
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
		printf '/bin/sh'
	fi
}

LOCAL_DIR=""
if [ -n "${0:-}" ] && [ -f "$0" ]; then
	LOCAL_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." 2>/dev/null && pwd || true)"
fi

fetch_lite_script() {
	dest="$1"
	if [ "$EXPLICIT_LITE" -eq 1 ] && [ -n "$BIN_URL" ]; then
		if fetch_file "$BIN_URL" "$dest" "$DL_TOOL" 2>/dev/null && verify_shell_script "$dest"; then
			return 0
		fi
		rm -f "$dest"
	fi

	server_lite="${SERVER_BASE}/agent-lite.sh"
	echo "Downloading lightweight agent from ${server_lite}..."
	if fetch_file "$server_lite" "$dest" "$DL_TOOL" 2>/dev/null && verify_shell_script "$dest"; then
		return 0
	fi
	rm -f "$dest"

	if [ -n "$LOCAL_DIR" ] && [ -f "${LOCAL_DIR}/openwrt/cslite-agent-lite.sh" ]; then
		cp "${LOCAL_DIR}/openwrt/cslite-agent-lite.sh" "$dest"
		verify_shell_script "$dest" && return 0
		rm -f "$dest"
	fi

	raw_lite="https://raw.githubusercontent.com/${REPO_DEFAULT}/main/agent/openwrt/cslite-agent-lite.sh"
	if fetch_file "$raw_lite" "$dest" "$DL_TOOL" 2>/dev/null && verify_shell_script "$dest"; then
		return 0
	fi
	rm -f "$dest"
	echo "Error: failed to download valid cslite-agent-lite.sh from ${server_lite} or fallback sources." >&2
	exit 1
}

fetch_openwrt_init() {
	dest="$1"
	if [ -n "$INIT_URL" ]; then
		if fetch_file "$INIT_URL" "$dest" "$DL_TOOL" 2>/dev/null && verify_shell_script "$dest"; then
			return 0
		fi
		rm -f "$dest"
	fi

	server_init="${SERVER_BASE}/openwrt/cslite-agent.init"
	if fetch_file "$server_init" "$dest" "$DL_TOOL" 2>/dev/null && verify_shell_script "$dest"; then
		return 0
	fi
	rm -f "$dest"

	if [ -n "$LOCAL_DIR" ] && [ -f "${LOCAL_DIR}/openwrt/cslite-agent.init" ]; then
		cp "${LOCAL_DIR}/openwrt/cslite-agent.init" "$dest"
		verify_shell_script "$dest" && return 0
		rm -f "$dest"
	fi

	raw_init="https://raw.githubusercontent.com/${REPO_DEFAULT}/main/agent/openwrt/cslite-agent.init"
	if fetch_file "$raw_init" "$dest" "$DL_TOOL" 2>/dev/null && verify_shell_script "$dest"; then
		return 0
	fi
	rm -f "$dest"
	return 1
}

run_lite_save_config() {
	lite_bin="$1"
	cfg_dir="$2"
	sh_bin="$3"

	set -- install --server "$SERVER" --key "$API_KEY"
	[ -n "$DEVICE_NAME" ] && set -- "$@" --name "$DEVICE_NAME"
	[ -n "$DEVICE_ID" ] && set -- "$@" --device-id "$DEVICE_ID"
	[ -n "$POLL_INTERVAL" ] && set -- "$@" --poll "$POLL_INTERVAL"
	[ -n "$HEARTBEAT_INTERVAL" ] && set -- "$@" --heartbeat "$HEARTBEAT_INTERVAL"
	[ "$USER_MODE" -eq 1 ] && set -- "$@" --user

	CSLITE_CONFIG_DIR="$cfg_dir" CSLITE_SKIP_SERVICE_EXEC=1 "$sh_bin" "$lite_bin" "$@"
}

