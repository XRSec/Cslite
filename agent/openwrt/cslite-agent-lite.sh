#!/bin/sh
# Purpose: Ultra-lightweight POSIX/BusyBox CSLite agent (OpenWrt, Linux, macOS, Android).
# Context: Served at /agent-lite.sh; assembled cleanly from agent/openwrt/lite/*.sh.
# Usage: cslite-agent-lite <run|install|uninstall|start|stop|restart|status|version> [options]
# Requires: POSIX sh, awk, and curl, wget, uclient-fetch, or openssl.

VERSION="v1.2.0"

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

run_awk() {
	if command -v awk >/dev/null 2>&1; then
		awk "$@"
		return $?
	fi
	for bb in /data/adb/magisk/busybox /data/adb/ksu/bin/busybox /data/adb/ap/bin/busybox; do
		if [ -x "$bb" ]; then
			"$bb" awk "$@"
			return $?
		fi
	done
	return 127
}

# JSON-escapes stdin (or $1) using pure awk with a POSIX sed fallback.
json_escape() {
	if [ $# -gt 0 ]; then
		printf '%s' "$1" | json_escape_stdin
	else
		json_escape_stdin
	fi
}

json_escape_stdin() {
	if command -v awk >/dev/null 2>&1 || [ -x /data/adb/magisk/busybox ] || [ -x /data/adb/ksu/bin/busybox ] || [ -x /data/adb/ap/bin/busybox ]; then
		run_awk '
		BEGIN {
			ORS = ""
			for (i = 1; i < 32; i++) {
				ctrl[sprintf("%c", i)] = sprintf("\\u%04x", i)
			}
			ctrl["\b"] = "\\b"
			ctrl["\f"] = "\\f"
			ctrl["\n"] = "\\n"
			ctrl["\r"] = "\\r"
			ctrl["\t"] = "\\t"
		}
		{
			if (NR > 1) printf "\\n"
			n = length($0)
			for (i = 1; i <= n; i++) {
				c = substr($0, i, 1)
				if (c == "\\") printf "\\\\"
				else if (c == "\"") printf "\\\""
				else if (c in ctrl) printf "%s", ctrl[c]
				else printf "%s", c
			}
		}
		'
		return $?
	fi
	# Pure POSIX sed fallback when awk is absent (e.g., stripped stock Android shell).
	first=1
	while IFS= read -r line || [ -n "$line" ]; do
		esc="$(printf '%s' "$line" | tr -d '\r' | sed 's/\\/\\\\/g; s/"/\\"/g')"
		if [ "$first" -eq 1 ]; then
			printf '%s' "$esc"
			first=0
		else
			printf '\\n%s' "$esc"
		fi
	done
}

json_quote() {
	printf '"%s"' "$(json_escape "$1")"
}

# Pure POSIX awk JSON reader fallback when OpenWrt jsonfilter is unavailable.
# Query format uses dot-separated keys and 0-based array indices, e.g. data.commands.0.content
# Special query "--env-lines <prefix>" prints KEY=VAL lines for object at prefix.
awk_json_query() {
	raw_json="$1"
	query_path="$2"
	if ! command -v awk >/dev/null 2>&1 && [ ! -x /data/adb/magisk/busybox ] && [ ! -x /data/adb/ksu/bin/busybox ] && [ ! -x /data/adb/ap/bin/busybox ]; then
		# Minimal flat-key sed fallback when awk is unavailable.
		key="${query_path##*.}"
		flat="$(printf '%s' "$raw_json" | tr -d '\n\r')"
		val="$(printf '%s' "$flat" | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1)"
		if [ -z "$val" ]; then
			val="$(printf '%s' "$flat" | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" | head -n 1)"
		fi
		printf '%s' "$val"
		return 0
	fi
	printf '%s\n' "$raw_json" | run_awk -v target="$query_path" '
	BEGIN {
		json = ""
		mode = "get"
		if (substr(target, 1, 12) == "--env-lines ") {
			mode = "env"
			target = substr(target, 13)
		}
		hex = "0123456789abcdef"
	}
	{
		if (NR > 1) json = json "\n"
		json = json $0
	}
	END {
		len = length(json)
		pos = 1
		skip_ws()
		parse_value("")
	}
	function skip_ws(    c) {
		while (pos <= len) {
			c = substr(json, pos, 1)
			if (c == " " || c == "\t" || c == "\n" || c == "\r") {
				pos++
			} else {
				break
			}
		}
	}
	function hex_val(ch,    i) {
		ch = tolower(ch)
		i = index(hex, ch)
		return (i > 0) ? (i - 1) : 0
	}
	function parse_string(    c, out, n, u1, u2, u3, u4, code) {
		pos++ # skip opening quote
		out = ""
		while (pos <= len) {
			c = substr(json, pos, 1)
			if (c == "\"") {
				pos++
				return out
			}
			if (c == "\\") {
				pos++
				if (pos > len) break
				n = substr(json, pos, 1)
				if (n == "\"" || n == "\\" || n == "/") out = out n
				else if (n == "b") out = out "\b"
				else if (n == "f") out = out "\f"
				else if (n == "n") out = out "\n"
				else if (n == "r") out = out "\r"
				else if (n == "t") out = out "\t"
				else if (n == "u" && pos + 4 <= len) {
					u1 = hex_val(substr(json, pos+1, 1))
					u2 = hex_val(substr(json, pos+2, 1))
					u3 = hex_val(substr(json, pos+3, 1))
					u4 = hex_val(substr(json, pos+4, 1))
					code = ((u1 * 16 + u2) * 16 + u3) * 16 + u4
					if (code > 0 && code < 128) out = out sprintf("%c", code)
					pos += 4
				} else out = out n
				pos++
			} else {
				out = out c
				pos++
			}
		}
		return out
	}
	function emit(path, val) {
		if (mode == "get") {
			if (path == target && !found) {
				printf "%s", val
				found = 1
			}
		} else if (mode == "env") {
			if (index(path, target ".") == 1) {
				k = substr(path, length(target) + 2)
				if (index(k, ".") == 0) {
					gsub(/\n/, " ", val)
					print k "=" val
				}
			}
		}
	}
	function parse_value(path,    c, key, idx, child, val, start) {
		skip_ws()
		if (pos > len) return
		c = substr(json, pos, 1)
		if (c == "{") {
			pos++
			skip_ws()
			if (substr(json, pos, 1) == "}") { pos++; return }
			while (pos <= len) {
				skip_ws()
				if (substr(json, pos, 1) != "\"") break
				key = parse_string()
				skip_ws()
				if (substr(json, pos, 1) == ":") pos++
				child = (path == "" ? key : path "." key)
				parse_value(child)
				skip_ws()
				if (substr(json, pos, 1) == ",") { pos++; continue }
				if (substr(json, pos, 1) == "}") { pos++; break }
				break
			}
		} else if (c == "[") {
			pos++
			skip_ws()
			if (substr(json, pos, 1) == "]") { pos++; return }
			idx = 0
			while (pos <= len) {
				child = (path == "" ? idx : path "." idx)
				parse_value(child)
				idx++
				skip_ws()
				if (substr(json, pos, 1) == ",") { pos++; continue }
				if (substr(json, pos, 1) == "]") { pos++; break }
				break
			}
		} else if (c == "\"") {
			val = parse_string()
			emit(path, val)
		} else {
			start = pos
			while (pos <= len) {
				c = substr(json, pos, 1)
				if (c == "," || c == "}" || c == "]" || c == " " || c == "\t" || c == "\n" || c == "\r") break
				pos++
			}
			val = substr(json, start, pos - start)
			if (val != "null") emit(path, val)
		}
	}
	'
}

json_get() {
	raw="$1"
	path="$2"
	if command -v jsonfilter >/dev/null 2>&1; then
		jf_expr="@"
		OLD_IFS="$IFS"
		IFS="."
		for seg in $path; do
			case "$seg" in
				''|*[!0-9]*) jf_expr="${jf_expr}.${seg}" ;;
				*) jf_expr="${jf_expr}[${seg}]" ;;
			esac
		done
		IFS="$OLD_IFS"
		out="$(printf '%s' "$raw" | jsonfilter -e "$jf_expr" 2>/dev/null)" || return 0
		printf '%s' "$out"
		return 0
	fi
	awk_json_query "$raw" "$path"
}

json_get_env_lines() {
	raw="$1"
	path="$2"
	awk_json_query "$raw" "--env-lines $path"
}

parse_http_url() {
	raw_url="$1"
	URL_SCHEME=""
	URL_HOST=""
	URL_PORT=""
	URL_PATH="/"
	URL_HOST_HDR=""

	case "$raw_url" in
		https://*) URL_SCHEME="https"; rest="${raw_url#https://}" ;;
		http://*) URL_SCHEME="http"; rest="${raw_url#http://}" ;;
		*) return 1 ;;
	esac

	rest="${rest%%#*}"
	auth_no_q="${rest%%\?*}"
	case "$auth_no_q" in
		*/*)
			authority="${auth_no_q%%/*}"
			URL_PATH="/${rest#*/}"
			;;
		*)
			authority="$auth_no_q"
			if [ "$auth_no_q" != "$rest" ]; then
				URL_PATH="/?${rest#*\?}"
			else
				URL_PATH="/"
			fi
			;;
	esac
	case "$authority" in
		*@*) authority="${authority##*@}" ;;
	esac
	[ -n "$authority" ] || return 1

	is_v6=0
	case "$authority" in
		\[*\]:*)
			is_v6=1
			tmp="${authority#\[}"
			URL_HOST="${tmp%%\]:*}"
			URL_PORT="${authority##*\]:}"
			;;
		\[*\])
			is_v6=1
			tmp="${authority#\[}"
			URL_HOST="${tmp%\]}"
			;;
		*:*)
			URL_HOST="${authority%%:*}"
			URL_PORT="${authority#*:}"
			;;
		*)
			URL_HOST="$authority"
			;;
	esac
	[ -n "$URL_HOST" ] || return 1

	if [ -z "$URL_PORT" ]; then
		if [ "$URL_SCHEME" = "https" ]; then
			URL_PORT="443"
		else
			URL_PORT="80"
		fi
	fi
	case "$URL_PORT" in
		''|*[!0-9]*) return 1 ;;
	esac

	if [ "$is_v6" -eq 1 ]; then
		URL_HOST_HDR="[${URL_HOST}]"
	else
		URL_HOST_HDR="$URL_HOST"
	fi
	if { [ "$URL_SCHEME" = "https" ] && [ "$URL_PORT" != "443" ]; } || \
	   { [ "$URL_SCHEME" = "http" ] && [ "$URL_PORT" != "80" ]; }; then
		URL_HOST_HDR="${URL_HOST_HDR}:${URL_PORT}"
	fi
	return 0
}

http_decode_response() {
	raw_f="$1"
	out_f="$2"
	err_f="$3"
	[ -s "$raw_f" ] || return 1

	meta="$(LC_ALL=C run_awk -v out_f="$out_f" '
	function hex_val(ch,    i) {
		i = index("0123456789abcdef", tolower(ch))
		return (i > 0) ? (i - 1) : -1
	}
	function parse_hex(s,    i, n, d, v) {
		v = 0
		n = length(s)
		if (n == 0) return -1
		for (i = 1; i <= n; i++) {
			d = hex_val(substr(s, i, 1))
			if (d < 0) return -1
			v = v * 16 + d
		}
		return v
	}
	BEGIN {
		in_body = 0
		got_status = 0
		status = 0
		chunked = 0
		hdr_bytes = 0
		cstate = "size"
		chunk_rem = 0
		chunk_done = 0
	}
	{
		if (!in_body) {
			hdr_bytes += length($0) + 1
			clean = $0
			sub(/\r$/, "", clean)
			if (clean == "") {
				if (status == 100) {
					got_status = 0
					status = 0
					chunked = 0
					next
				}
				in_body = 1
				if (!chunked) {
					exit
				}
				printf "" > out_f
				next
			}
			if (!got_status) {
				got_status = 1
				if (match(clean, /^HTTP\/[0-9.]*[ \t]+[0-9][0-9][0-9]/)) {
					sp = index(clean, " ")
					if (sp == 0) sp = index(clean, "\t")
					rest_st = substr(clean, sp + 1)
					sub(/^[ \t]+/, "", rest_st)
					status = substr(rest_st, 1, 3) + 0
				}
			} else {
				low = tolower(clean)
				if (low ~ /^transfer-encoding:[ \t]*.*chunked/) {
					chunked = 1
				}
			}
			next
		}
		if (cstate == "done") next
		if (cstate == "crlf") {
			if ($0 != "" && $0 != "\r") {
				status = 0
				exit
			}
			cstate = "size"
			next
		}
		if (cstate == "size") {
			sz_line = $0
			sub(/\r$/, "", sz_line)
			sub(/;.*$/, "", sz_line)
			gsub(/^[ \t]+|[ \t]+$/, "", sz_line)
			if (sz_line == "") next
			chunk_rem = parse_hex(sz_line)
			if (chunk_rem < 0) {
				status = 0
				exit
			}
			if (chunk_rem == 0) {
				cstate = "done"
				chunk_done = 1
				exit
			}
			cstate = "data"
			next
		}
		raw_line = $0 "\n"
		rlen = length(raw_line)
		if (rlen <= chunk_rem) {
			printf "%s", raw_line > out_f
			chunk_rem -= rlen
			if (chunk_rem == 0) {
				cstate = "crlf"
			}
		} else {
			printf "%s", substr(raw_line, 1, chunk_rem) > out_f
			chunk_rem = 0
			cstate = "size"
		}
	}
	END {
		if (!in_body) status = 0
		if (chunked) close(out_f)
		printf "%d %d %d %d\n", status + 0, chunked + 0, hdr_bytes + 0, chunk_done + 0
	}
	' "$raw_f")" || return 1

	set -- $meta
	status_code="${1:-0}"
	is_chunked="${2:-0}"
	hdr_bytes="${3:-0}"
	chunk_done="${4:-0}"

	case "$status_code" in
		''|*[!0-9]*|0) return 1 ;;
	esac
	if [ "$is_chunked" -eq 1 ] && [ "$chunk_done" -ne 1 ]; then
		return 1
	fi
	if [ "$is_chunked" -eq 0 ]; then
		{ dd bs=1 count="$hdr_bytes" >/dev/null 2>&1; cat; } < "$raw_f" > "$out_f" || return 1
	fi

	if [ "$status_code" -ge 200 ] && [ "$status_code" -lt 300 ]; then
		return 0
	fi
	printf 'HTTP %s\n' "$status_code" >"$err_f"
	return 1
}

resolve_request_headers() {
	REQ_UA="${USER_AGENT:-CSLite-Agent/lite-${VERSION}}"
	base_root="${BASE_URL%/api}"
	REQ_REFERER="${REFERER:-${base_root}/agent/telemetry}"
}

write_http_request() {
	method="$1"
	req_path="$2"
	host_hdr="$3"
	body="${4:-}"
	content_len="${5:-}"
	resolve_request_headers
	printf '%s %s HTTP/1.1\r\nHost: %s\r\nUser-Agent: %s\r\nReferer: %s\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nX-API-Key: %s\r\nConnection: close\r\n' \
		"$method" "$req_path" "$host_hdr" "$REQ_UA" "$REQ_REFERER" "$API_KEY"
	if [ "$method" = "POST" ]; then
		printf 'Content-Type: application/json\r\nContent-Length: %s\r\n\r\n%s' "$content_len" "$body"
	else
		printf '\r\n'
	fi
}

openssl_http_request() {
	method="$1"
	full_url="$2"
	body="${3:-}"
	out_f="$4"
	err_f="$5"

	if ! parse_http_url "$full_url"; then
		printf 'invalid URL: %s\n' "$full_url" >"$err_f"
		return 1
	fi

	raw_f="${out_f}.raw"
	rm -f "$raw_f" "$out_f"

	content_len=""
	if [ "$method" = "POST" ]; then
		content_len="$(printf '%s' "$body" | wc -c | tr -d ' \t\r\n')"
	fi

	trc=0
	if [ "$URL_SCHEME" = "https" ]; then
		connect_host="$URL_HOST"
		case "$connect_host" in
			*:*) connect_host="[${connect_host}]" ;;
		esac
		write_http_request "$method" "$URL_PATH" "$URL_HOST_HDR" "$body" "$content_len" | \
			"$HTTP_CLIENT" s_client -quiet -ign_eof -connect "${connect_host}:${URL_PORT}" -servername "$URL_HOST" >"$raw_f" 2>"$err_f" || trc=$?
	elif [ "$URL_SCHEME" = "http" ]; then
		nc_bin=""
		if command -v nc >/dev/null 2>&1; then
			nc_bin="nc"
		elif [ -x /usr/bin/nc ]; then
			nc_bin="/usr/bin/nc"
		elif [ -x /bin/nc ]; then
			nc_bin="/bin/nc"
		fi
		if [ -z "$nc_bin" ]; then
			printf 'nc not found for plain HTTP fallback\n' >"$err_f"
			rm -f "$raw_f"
			return 1
		fi
		write_http_request "$method" "$URL_PATH" "$URL_HOST_HDR" "$body" "$content_len" | \
			"$nc_bin" "$URL_HOST" "$URL_PORT" >"$raw_f" 2>"$err_f" || trc=$?
	else
		printf 'unsupported URL scheme: %s\n' "$URL_SCHEME" >"$err_f"
		rm -f "$raw_f"
		return 1
	fi

	if [ ! -s "$raw_f" ]; then
		rm -f "$raw_f"
		[ "$trc" -ne 0 ] && return "$trc"
		return 1
	fi

	http_decode_response "$raw_f" "$out_f" "$err_f"
	drc=$?
	rm -f "$raw_f"
	return "$drc"
}

http_request() {
	method="$1"
	path="$2"
	body="${3:-}"
	url="${BASE_URL}${path}"
	resolve_request_headers

	mkdir -p "$TMP_DIR" 2>/dev/null || true
	http_tmp="${TMP_DIR}/cslite-http.$$"
	out_f="${http_tmp}.out"
	err_f="${http_tmp}.err"
	rc=0

	case "$HTTP_CLIENT" in
		curl|/system/bin/curl)
			if [ "$method" = "POST" ]; then
				"$HTTP_CLIENT" -sS --connect-timeout 10 -m 30 -X POST -o "$out_f" \
					-A "$REQ_UA" \
					-H "Referer: $REQ_REFERER" \
					-H "Content-Type: application/json" \
					-H "X-API-Key: $API_KEY" \
					-d "$body" "$url" 2>"$err_f" || rc=$?
			else
				"$HTTP_CLIENT" -sS --connect-timeout 10 -m 30 -o "$out_f" \
					-A "$REQ_UA" \
					-H "Referer: $REQ_REFERER" \
					-H "X-API-Key: $API_KEY" "$url" 2>"$err_f" || rc=$?
			fi
			;;
		wget|/system/bin/wget)
			if [ "$method" = "POST" ]; then
				"$HTTP_CLIENT" -O "$out_f" \
					--header="User-Agent: $REQ_UA" \
					--header="Referer: $REQ_REFERER" \
					--header="Content-Type: application/json" \
					--header="X-API-Key: $API_KEY" \
					--post-data="$body" "$url" 2>"$err_f" || rc=$?
			else
				"$HTTP_CLIENT" -O "$out_f" \
					--header="User-Agent: $REQ_UA" \
					--header="Referer: $REQ_REFERER" \
					--header="X-API-Key: $API_KEY" "$url" 2>"$err_f" || rc=$?
			fi
			;;
		uclient-fetch)
			if [ "$method" = "POST" ]; then
				uclient-fetch -O "$out_f" --post-data="$body" "$url" 2>"$err_f" || rc=$?
			else
				uclient-fetch -O "$out_f" "$url" 2>"$err_f" || rc=$?
			fi
			;;
		openssl|*/openssl)
			openssl_http_request "$method" "$url" "$body" "$out_f" "$err_f" || rc=$?
			;;
		*)
			rm -f "$out_f" "$err_f"
			return 1
			;;
	esac

	resp_body="$(cat "$out_f" 2>/dev/null || true)"
	err_text="$(cat "$err_f" 2>/dev/null || true)"
	rm -f "$out_f" "$err_f"

	if [ "$rc" -eq 0 ]; then
		printf '%s' "$resp_body"
		return 0
	fi

	case "$resp_body" in
		*40010*)
			printf '%s' "$resp_body"
			return 0
			;;
	esac

	case "$err_text" in
		*404*|*"Not Found"*)
			case "$resp_body" in
				\{*) printf '%s' "$resp_body" ;;
				*) printf '%s' '{"code":40010,"message":"device not found"}' ;;
			esac
			return 0
			;;
	esac

	return "$rc"
}

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

sanitize_int() {
	case "${1:-}" in
		''|*[!0-9]*) printf '0' ;;
		*) printf '%s' "$1" ;;
	esac
}

sanitize_float() {
	case "${1:-}" in
		''|*[!0-9.]*|*.*.*) printf '0' ;;
		*) printf '%s' "$1" ;;
	esac
}

is_uint() {
	case "${1:-}" in
		''|*[!0-9]*) return 1 ;;
		*) return 0 ;;
	esac
}

read_proc_cpu() {
	[ -r "$PROC_STAT_FILE" ] || return 1
	stat_raw="$(cat "$PROC_STAT_FILE" 2>/dev/null || true)"
	[ -n "$stat_raw" ] || return 1
	printf '%s\n' "$stat_raw" | run_awk '
	$1 == "cpu" {
		tot = 0
		for (i = 2; i <= NF && i <= 9; i++) tot += $i
		idle = (NF >= 5 ? $5 : 0) + (NF >= 6 ? $6 : 0)
		printf "%.0f %.0f", tot + 0, idle + 0
		exit
	}' 2>/dev/null
}

read_proc_net() {
	[ -r "$PROC_NET_DEV_FILE" ] || return 1
	net_raw="$(cat "$PROC_NET_DEV_FILE" 2>/dev/null || true)"
	[ -n "$net_raw" ] || return 1
	printf '%s\n' "$net_raw" | run_awk '
	NR > 2 {
		idx = index($0, ":")
		if (idx == 0) next
		iface = substr($0, 1, idx - 1)
		gsub(/^[ \t]+|[ \t]+$/, "", iface)
		if (iface == "" || iface == "lo") next
		rest = substr($0, idx + 1)
		n = split(rest, f, /[ \t]+/)
		# Handle leading space creating empty f[1]
		off = (f[1] == "" ? 1 : 0)
		if (n - off >= 9) {
			rx += f[1 + off] + 0
			tx += f[9 + off] + 0
		}
	}
	END { printf "%.0f %.0f", rx + 0, tx + 0 }' 2>/dev/null
}

prime_metrics_baseline() {
	if [ -r "$PROC_STAT_FILE" ]; then
		set -- $(read_proc_cpu || true)
		p_tot="${1:-}"
		p_idle="${2:-}"
		if is_uint "$p_tot" && is_uint "$p_idle"; then
			PREV_CPU_TOTAL="$p_tot"
			PREV_CPU_IDLE="$p_idle"
		fi
	fi
	if [ -r "$PROC_NET_DEV_FILE" ]; then
		set -- $(read_proc_net || true)
		p_rx="${1:-}"
		p_tx="${2:-}"
		p_ts="$(date +%s 2>/dev/null || echo 0)"
		if is_uint "$p_rx" && is_uint "$p_tx" && is_uint "$p_ts"; then
			PREV_NET_RX="$p_rx"
			PREV_NET_TX="$p_tx"
			PREV_NET_TS="$p_ts"
		fi
	fi
}

collect_metrics() {
	cpu_usage=0
	mem_used=0
	mem_total=0
	mem_pct=0
	disk_pct=0
	disk_total=0
	net_in=0
	net_out=0
	load_avg=""
	uptime_sec=0
	plat="$(detect_platform)"

	if [ -z "$PREV_CPU_TOTAL" ] && [ -z "$PREV_NET_RX" ] && is_pos_int "${METRICS_PRIME_DELAY:-1}" && { [ -r "$PROC_STAT_FILE" ] || [ -r "$PROC_NET_DEV_FILE" ]; }; then
		prime_metrics_baseline
		sleep "$METRICS_PRIME_DELAY"
	fi

	# Guard /proc/stat gracefully (Android SELinux may deny read).
	if [ -r "$PROC_STAT_FILE" ]; then
		set -- $(read_proc_cpu || true)
		cur_tot="${1:-}"
		cur_idle="${2:-}"
		if is_uint "$cur_tot" && is_uint "$cur_idle"; then
			if is_uint "$PREV_CPU_TOTAL" && is_uint "$PREV_CPU_IDLE"; then
				cpu_usage="$(run_awk -v pt="$PREV_CPU_TOTAL" -v pi="$PREV_CPU_IDLE" -v ct="$cur_tot" -v ci="$cur_idle" '
				BEGIN {
					pt += 0; pi += 0; ct += 0; ci += 0
					dt = ct - pt; di = ci - pi
					if (dt <= 0) { print "0"; exit }
					if (di < 0) di = 0
					if (di >= dt) { print "0"; exit }
					printf "%.2f", ((dt - di) / dt) * 100
				}' 2>/dev/null || printf '0')"
			fi
			PREV_CPU_TOTAL="$cur_tot"
			PREV_CPU_IDLE="$cur_idle"
		fi
	fi

	# Guard /proc/net/dev gracefully (Android SELinux may deny read).
	if [ -r "$PROC_NET_DEV_FILE" ]; then
		set -- $(read_proc_net || true)
		cur_rx="${1:-}"
		cur_tx="${2:-}"
		now_ts="$(date +%s 2>/dev/null || echo 0)"
		if is_uint "$cur_rx" && is_uint "$cur_tx" && is_uint "$now_ts"; then
			if is_uint "$PREV_NET_RX" && is_uint "$PREV_NET_TX" && is_uint "$PREV_NET_TS"; then
				dt=$((now_ts - PREV_NET_TS))
				if [ "$dt" -gt 0 ]; then
					set -- $(run_awk -v pr="$PREV_NET_RX" -v cr="$cur_rx" -v pt="$PREV_NET_TX" -v ct="$cur_tx" -v dt="$dt" '
					function rate_kb(p, c, d) {
						p += 0; c += 0; d += 0
						if (c >= p && d > 0) return int(((c - p) / d / 1024) + 0.5)
						return 0
					}
					BEGIN { printf "%.0f %.0f", rate_kb(pr, cr, dt), rate_kb(pt, ct, dt) }' 2>/dev/null || true)
					net_in="${1:-0}"
					net_out="${2:-0}"
				fi
			fi
			PREV_NET_RX="$cur_rx"
			PREV_NET_TX="$cur_tx"
			PREV_NET_TS="$now_ts"
		fi
	fi

	if [ -r "$PROC_MEMINFO_FILE" ]; then
		mem_raw="$(cat "$PROC_MEMINFO_FILE" 2>/dev/null || true)"
		if [ -n "$mem_raw" ]; then
			set -- $(printf '%s\n' "$mem_raw" | run_awk '
			/^MemTotal:/ { tot=$2 }
			/^MemAvailable:/ { avail=$2; has=1 }
			/^MemFree:/ { free=$2 }
			/^Buffers:/ { buf=$2 }
			/^Cached:/ { cache=$2 }
			/^SReclaimable:/ { srec=$2 }
			END {
				if (tot <= 0) { print "0 0 0"; exit }
				if (!has) avail = free + buf + cache + srec
				if (avail > tot) avail = tot
				used = tot - avail
				printf "%d %d %.2f", int(used/1024), int(tot/1024), (used/tot)*100
			}' 2>/dev/null || true)
			mem_used="${1:-0}"
			mem_total="${2:-0}"
			mem_pct="${3:-0}"
		fi
	elif [ "$plat" = "macos" ] && command -v sysctl >/dev/null 2>&1; then
		hw_bytes="$(sysctl -n hw.memsize 2>/dev/null || true)"
		case "$hw_bytes" in
			''|*[!0-9]*) ;;
			*) mem_total=$((hw_bytes / 1048576)) ;;
		esac
	fi

	disk_target="/"
	if [ "$plat" = "android" ] && [ -d /data ]; then
		disk_target="/data"
	elif [ "$plat" = "openwrt" ] && [ -d /overlay ]; then
		disk_target="/overlay"
	fi
	df_out="$(df -k "$disk_target" 2>/dev/null)" || df_out=""
	if [ -z "$df_out" ] && [ "$disk_target" != "/" ]; then
		df_out="$(df -k / 2>/dev/null || true)"
	fi
	if [ -n "$df_out" ]; then
		set -- $(printf '%s\n' "$df_out" | run_awk '
		NR > 1 && !found {
			if (NF >= 6 && ($2 + 0) > 0) { tot = $2; used = $3; found = 1 }
			else if (NF == 5 && ($1 + 0) > 0) { tot = $1; used = $2; found = 1 }
		}
		END {
			if (found && tot > 0) printf "%.2f %d", (used/tot)*100, int(tot/1024);
			else print "0 0"
		}' 2>/dev/null || true)
		disk_pct="${1:-0}"
		disk_total="${2:-0}"
	fi

	if [ -r "$PROC_LOADAVG_FILE" ]; then
		la_raw="$(cat "$PROC_LOADAVG_FILE" 2>/dev/null || true)"
		if [ -n "$la_raw" ]; then
			load_avg="$(printf '%s\n' "$la_raw" | run_awk '{print $1" "$2" "$3}' 2>/dev/null || true)"
		fi
	elif [ "$plat" = "macos" ] && command -v sysctl >/dev/null 2>&1; then
		load_avg="$(sysctl -n vm.loadavg 2>/dev/null | run_awk '{gsub(/[{}]/, ""); if (NF>=3) print $1" "$2" "$3}' 2>/dev/null || true)"
	fi

	if [ -r "$PROC_UPTIME_FILE" ]; then
		up_raw="$(cat "$PROC_UPTIME_FILE" 2>/dev/null || true)"
		if [ -n "$up_raw" ]; then
			uptime_sec="$(printf '%s\n' "$up_raw" | run_awk '{print int($1)}' 2>/dev/null || printf '0')"
		fi
	elif [ "$plat" = "macos" ] && command -v sysctl >/dev/null 2>&1; then
		boot_sec="$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/.*sec = \([0-9]*\).*/\1/p' | head -n 1 || true)"
		now_s="$(date +%s 2>/dev/null || echo 0)"
		case "$boot_sec:$now_s" in
			''|*[!0-9:]*|:*) ;;
			*) [ "$now_s" -gt "$boot_sec" ] && uptime_sec=$((now_s - boot_sec)) ;;
		esac
	fi

	cpu_usage="$(sanitize_float "$cpu_usage")"
	mem_used="$(sanitize_int "$mem_used")"
	mem_total="$(sanitize_int "$mem_total")"
	mem_pct="$(sanitize_float "$mem_pct")"
	disk_pct="$(sanitize_float "$disk_pct")"
	disk_total="$(sanitize_int "$disk_total")"
	net_in="$(sanitize_int "$net_in")"
	net_out="$(sanitize_int "$net_out")"
	uptime_sec="$(sanitize_int "$uptime_sec")"

	METRICS_JSON="$(printf '{"cpu_usage":%s,"memory_used":%s,"memory_total":%s,"memory_percent":%s,"disk_usage":%s,"disk_total":%s,"network_in":%s,"network_out":%s,"load_avg":%s,"uptime":%s,"ip_addresses":%s}' \
		"$cpu_usage" "$mem_used" "$mem_total" "$mem_pct" "$disk_pct" "$disk_total" "$net_in" "$net_out" "$(json_quote "$load_avg")" "$uptime_sec" "$(collect_ip_addresses_json)")"
}

collect_ip_addresses_json() {
	raw_ips=""
	if command -v ip >/dev/null 2>&1; then
		raw_ips="$(ip -o addr show 2>/dev/null | run_awk '
		/inet6? / {
			for (i = 1; i <= NF; i++) {
				if ($i == "inet" || $i == "inet6") {
					addr = $(i + 1)
					sub(/\/.*/, "", addr)
					sub(/%.*/, "", addr)
					if (addr != "") print addr
					break
				}
			}
		}' 2>/dev/null || true)"
	fi
	if [ -z "$raw_ips" ] && command -v ifconfig >/dev/null 2>&1; then
		raw_ips="$({ ifconfig -a 2>/dev/null || ifconfig 2>/dev/null || true; } | run_awk '
		/inet / {
			for (i = 1; i <= NF; i++) {
				if ($i ~ /^addr:/ && length($i) > 5) { print substr($i, 6); break }
				if ($i == "inet" && $(i + 1) ~ /^[0-9.]+$/) { print $(i + 1); break }
			}
		}
		/inet6 / {
			for (i = 1; i <= NF; i++) {
				if ($i ~ /^addr:/ && length($i) > 5) { a = substr($i, 6); sub(/\/.*/, "", a); sub(/%.*/, "", a); print a; break }
				if ($i == "inet6" && $(i + 1) ~ /:/) { a = $(i + 1); sub(/\/.*/, "", a); sub(/%.*/, "", a); print a; break }
			}
		}' 2>/dev/null || true)"
	fi
	if [ -z "$raw_ips" ]; then
		printf '[]'
		return 0
	fi
	printf '%s\n' "$raw_ips" | run_awk '
	{
		ip = $0
		gsub(/^[ \t\r]+|[ \t\r]+$/, "", ip)
		if (ip == "" || ip !~ /^[0-9A-Fa-f.:]+$/) next
		low = tolower(ip)
		if (low ~ /^127\./ || low ~ /^169\.254\./ || low == "0.0.0.0" || low == "::1" || low == "::" || low ~ /^fe80:/ || low ~ /^ff/) next
		if (!seen[ip]++) {
			ips[++n] = ip
			if (n >= 128) exit
		}
	}
	END {
		printf "["
		for (i = 1; i <= n; i++) {
			if (i > 1) printf ","
			printf "\"%s\"", ips[i]
		}
		printf "]"
	}' 2>/dev/null || printf '[]'
}

collect_metrics_json() {
	collect_metrics
	printf '%s' "$METRICS_JSON"
}

send_heartbeat() {
	collect_metrics
	metrics_json="$METRICS_JSON"
	host="$(hostname 2>/dev/null || uname -n 2>/dev/null || true)"
	osver="$(detect_os_version)"
	ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"

	payload="{\"agent_id\":$(json_quote "$AGENT_ID"),\"device_id\":$(json_quote "$BOUND_DEVICE_ID"),\"api_key\":$(json_quote "$API_KEY"),\"metrics\":${metrics_json},\"version\":$(json_quote "$VERSION"),\"os_version\":$(json_quote "$osver"),\"hostname\":$(json_quote "$host"),\"timestamp\":$(json_quote "$ts")}"

	resp="$(http_request POST "/agent/heartbeat" "$payload")" || return 1
	code="$(json_get "$resp" "code")"
	if [ "$code" = "40010" ]; then
		log_msg WARN "server returned 40010 (DEVICE_NOT_FOUND); re-registering"
		rm -f "$STATE_FILE"
		register_agent || return 1
		payload="{\"agent_id\":$(json_quote "$AGENT_ID"),\"device_id\":$(json_quote "$BOUND_DEVICE_ID"),\"api_key\":$(json_quote "$API_KEY"),\"metrics\":${metrics_json},\"version\":$(json_quote "$VERSION"),\"os_version\":$(json_quote "$osver"),\"hostname\":$(json_quote "$host"),\"timestamp\":$(json_quote "$ts")}"
		resp="$(http_request POST "/agent/heartbeat" "$payload")" || return 1
		code="$(json_get "$resp" "code")"
	fi

	if [ "$code" != "20000" ]; then
		log_msg ERROR "heartbeat failed (code=${code:-unknown}): $resp"
		return 1
	fi
	apply_server_intervals "$(json_get "$resp" "data.next_heartbeat")" "$(json_get "$resp" "data.poll_interval")"
	LAST_HB_SYNC="$(date +%s 2>/dev/null || echo 0)"
	log_msg DEBUG "heartbeat ok"
	return 0
}

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
