
find_config() {
	if [ -n "$CFG_FILE" ] && [ -f "$CFG_FILE" ]; then printf '%s' "$CFG_FILE"; return 0; fi
	for d in "${CSLITE_CONFIG_DIR:-}" "/etc/cslite-agent" "/data/cslite-agent" "/data/adb/cslite-agent" \
		"/Library/Application Support/cslite-agent" "${HOME:-}/Library/Application Support/cslite-agent" \
		"${HOME:-}/.config/cslite-agent"; do
		[ -n "$d" ] && [ -f "${d%/}/config.json" ] && { printf '%s' "${d%/}/config.json"; return 0; }
	done
	return 1
}

read_server_from_config() {
	[ -f "$1" ] || return 0
	sed -n 's/.*"server"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1 || true
}

find_target_bin() {
	wanted="$1"
	for d in "${CSLITE_INSTALL_DIR:-}" "/usr/local/bin" "/usr/bin" "/etc/cslite-agent" \
		"/data/cslite-agent" "${HOME:-}/.local/bin" "/data/adb/cslite-agent" \
		"/data/data/com.termux/files/usr/bin" "/tmp"; do
		[ -n "$d" ] && [ -x "${d%/}/${wanted}" ] && { printf '%s' "${d%/}/${wanted}"; return 0; }
	done
	return 1
}

verify_upgrade_payload() {
	file="$1"; mode="$2"; os_kind="$3"
	[ -s "$file" ] || return 1
	if [ "$mode" = "lite" ]; then
		first="$(sed -n '1p' "$file" 2>/dev/null | tr -d '\r' || true)"
		case "$first" in "#!"*) return 0 ;; *) return 1 ;; esac
	fi
	sz="$(wc -c < "$file" 2>/dev/null | tr -d ' ' || echo 0)"
	case "$sz" in ''|*[!0-9]*) sz=0 ;; esac
	[ "$sz" -ge 1024 ] || return 1
	magic=""
	if command -v od >/dev/null 2>&1; then
		magic="$(dd if="$file" bs=1 count=4 2>/dev/null | od -A n -t x1 2>/dev/null | tr -d ' \t\r\n' || true)"
	elif command -v hexdump >/dev/null 2>&1; then
		magic="$(dd if="$file" bs=1 count=4 2>/dev/null | hexdump -v -e '1/1 "%02x"' 2>/dev/null || true)"
	fi
	if [ -n "$magic" ]; then
		case "$os_kind" in
			macos|darwin)
				case "$magic" in cffaedfe|cefaedfe|cafebabe|feedfacf|feedface) return 0 ;; *) return 1 ;; esac ;;
			*) [ "$magic" = "7f454c46" ] && return 0 || return 1 ;;
		esac
	fi
	head_txt="$(dd if="$file" bs=1 count=32 2>/dev/null | tr -d '\0' || true)"
	case "$head_txt" in ""|'<'*|'#'*|'{'*) return 1 ;; esac
	return 0
}

detect_restart_kind() {
	if [ -x /etc/init.d/cslite-agent ] && [ ! -d /run/systemd/system ]; then
		if [ -f /etc/openwrt_release ] || grep -q 'procd' /etc/init.d/cslite-agent 2>/dev/null; then
			printf 'openwrt'; return 0
		fi
	fi
	if command -v rc-service >/dev/null 2>&1 && { [ -x /etc/init.d/cslite-agent ] || [ -f "${CSLITE_OPENRC_ROOT:-}/etc/init.d/cslite-agent" ]; }; then
		printf 'openrc'; return 0
	fi
	if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
		if [ "$(id -u)" -ne 0 ] && systemctl --user status cslite-agent >/dev/null 2>&1; then
			printf 'systemd-user'; return 0
		fi
		printf 'systemd'; return 0
	fi
	if [ "$OS" = "macos" ] && command -v launchctl >/dev/null 2>&1; then
		if [ "$(id -u)" -eq 0 ]; then printf 'launchd-system'; else printf 'launchd-user'; fi
		return 0
	fi
	printf 'nohup'
}

restart_agent() {
	kind="$1"; target="$2"; cfg="$3"
	case "$kind" in
		openwrt) /etc/init.d/cslite-agent restart ;;
		openrc) rc-service cslite-agent restart ;;
		systemd) systemctl restart cslite-agent ;;
		systemd-user) systemctl --user restart cslite-agent ;;
		launchd-system) launchctl kickstart -k system/com.cslite.agent ;;
		launchd-user) launchctl kickstart -k "gui/$(id -u)/com.cslite.agent" ;;
		*)
			for pf in /var/run/cslite-agent.pid /tmp/cslite-agent.pid /tmp/cslite-agent-lite.pid; do
				if [ -f "$pf" ]; then
					old_pid="$(tr -d ' \r\n' < "$pf" 2>/dev/null || true)"
					[ -n "$old_pid" ] && kill "$old_pid" 2>/dev/null || true
					rm -f "$pf"
				fi
			done
			logf="${TMPDIR:-/tmp}/cslite-agent.log"
			if command -v nohup >/dev/null 2>&1; then
				nohup "$target" run --config "$cfg" >"$logf" 2>&1 </dev/null &
			else
				( trap '' HUP; exec "$target" run --config "$cfg" ) >"$logf" 2>&1 </dev/null &
			fi
			;;
	esac
}

OS="${CSLITE_UPGRADE_OS:-$(detect_os)}"
ARCH="${CSLITE_UPGRADE_ARCH:-$(detect_arch)}"
FOUND_CFG="$(find_config || true)"
if [ -z "$SERVER" ] && [ -n "$FOUND_CFG" ]; then SERVER="$(read_server_from_config "$FOUND_CFG")"; fi
if [ -z "$SERVER" ]; then
	case "$DEFAULT_SERVER" in __CSLITE_*) ;; http://*|https://*) SERVER="$DEFAULT_SERVER" ;; esac
fi
SERVER_BASE="${SERVER%/}"
case "$SERVER_BASE" in */api) SERVER_BASE="${SERVER_BASE%/api}" ;; esac

FULL_BIN="$(find_target_bin cslite-agent || true)"
LITE_BIN="$(find_target_bin cslite-agent-lite || true)"
if [ "$FORCE_LITE" -eq 1 ]; then
	MODE="lite"
	TARGET_BIN="${LITE_BIN:-/usr/local/bin/cslite-agent-lite}"
elif [ -n "$FULL_BIN" ]; then
	MODE="full"
	TARGET_BIN="$FULL_BIN"
elif [ -n "$LITE_BIN" ]; then
	MODE="lite"
	TARGET_BIN="$LITE_BIN"
else
	echo "Error: installed cslite-agent not found; pass --lite or install first." >&2
	exit 1
fi

DL_URL="$BIN_URL"
if [ -z "$DL_URL" ]; then
	if [ "$MODE" = "lite" ]; then
		[ -n "$SERVER_BASE" ] || { echo "Error: --server or config.json server is required for lite upgrade." >&2; exit 1; }
		DL_URL="${SERVER_BASE}/agent-lite.sh"
	else
		BIN_OS="$OS"
		[ "$BIN_OS" = "openwrt" ] && BIN_OS="linux"
		[ "$BIN_OS" = "macos" ] && BIN_OS="darwin"
		if [ "$VERSION" = "latest" ]; then
			DL_URL="https://github.com/${REPO_DEFAULT}/releases/latest/download/cslite-agent-${BIN_OS}-${ARCH}"
		else
			DL_URL="https://github.com/${REPO_DEFAULT}/releases/download/${VERSION}/cslite-agent-${BIN_OS}-${ARCH}"
		fi
	fi
fi

RESTART_KIND="$(detect_restart_kind)"
if [ "$DRY_RUN" -eq 1 ]; then
	printf 'mode=%s\ntarget=%s\nurl=%s\nconfig=%s\nrestart=%s\n' \
		"$MODE" "$TARGET_BIN" "$DL_URL" "${FOUND_CFG:-}" "$RESTART_KIND"
	exit 0
fi

DL_TOOL="$(probe_downloader)"
TMP_FILE="${TARGET_BIN}.new.$$"
trap 'rm -f "$TMP_FILE" "${TMP_FILE}.raw."*' EXIT INT TERM
echo "Upgrading CSLite agent (${MODE}: ${TARGET_BIN}) via ${DL_TOOL} from ${DL_URL}..."
fetch_file "$DL_URL" "$TMP_FILE" "$DL_TOOL" 30 || {
	echo "Error: failed to download ${DL_URL}; aborting without modifying ${TARGET_BIN}." >&2
	exit 1
}
verify_upgrade_payload "$TMP_FILE" "$MODE" "$OS" || {
	echo "Error: downloaded ${MODE} payload failed verification; aborting without modifying ${TARGET_BIN}." >&2
	exit 1
}
chmod 0755 "$TMP_FILE"
mv "$TMP_FILE" "$TARGET_BIN"
trap - EXIT INT TERM

if [ "${CSLITE_SKIP_SERVICE_EXEC:-0}" != "1" ]; then
	trap '' HUP TERM
	restart_agent "$RESTART_KIND" "$TARGET_BIN" "${FOUND_CFG:-/etc/cslite-agent/config.json}"
fi
echo "CSLite agent upgraded successfully (${MODE} -> ${TARGET_BIN})."
