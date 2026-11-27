#!/bin/sh
# Universal POSIX/BusyBox Auto-Detect Installer for Cslite Agent (Linux, OpenWrt, macOS, Android)
# Works cleanly when piped via: curl -fsSL .../i | sh -s -- <api_key> [device_id]

set -eu

DEFAULT_SERVER="__CSLITE_DEFAULT_SERVER__"

SERVER=""
API_KEY=""
DEVICE_NAME=""
DEVICE_ID=""
POLL_INTERVAL="${CSLITE_POLL_INTERVAL:-}"
HEARTBEAT_INTERVAL="${CSLITE_HEARTBEAT_INTERVAL:-}"
BIN_URL="${CSLITE_BIN_URL:-}"
INIT_URL="${CSLITE_INIT_URL:-}"
VERSION="${CSLITE_VERSION:-latest}"
LITE_MODE=0
[ "${CSLITE_LITE:-0}" = "1" ] && LITE_MODE=1
EXPLICIT_LITE="$LITE_MODE"
USER_MODE=0
[ "${CSLITE_USER:-0}" = "1" ] && USER_MODE=1

REPO_DEFAULT="XRSec/Cslite"

usage() {
	cat <<EOF
Usage: install.sh [--server <url>] [--key <api_key>] [options]
   or: install.sh <api_key> [device_id] [name]

Options:
  --server <url>       Cslite server URL (or CSLITE_SERVER)
  --key <api_key>      Agent API key (or CSLITE_API_KEY)
  --name <name>        Device display name (or CSLITE_NAME)
  --device-id <id>     Pre-created device ID (or CSLITE_DEVICE_ID)
  --poll <seconds>     Command poll interval (or CSLITE_POLL_INTERVAL)
  --heartbeat <sec>    Heartbeat interval (or CSLITE_HEARTBEAT_INTERVAL)
  --lite               Install lightweight POSIX/BusyBox shell agent
  --bin-url <url>      Custom download URL or local path for agent binary/script
  --init-url <url>     Custom download URL or local path for OpenWrt init script
  --version <tag>      Release version tag (default: latest)
  --user               Install into user-local path and user service
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
		--init-url) [ $# -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }; INIT_URL="$2"; shift 2 ;;
		--init-url=*) INIT_URL="${1#*=}"; shift ;;
		--version) [ $# -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }; VERSION="$2"; shift 2 ;;
		--version=*) VERSION="${1#*=}"; shift ;;
		--lite) LITE_MODE=1; EXPLICIT_LITE=1; shift ;;
		--user) USER_MODE=1; shift ;;
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

is_writable_dir() {
	[ -n "${1:-}" ] && [ -d "$1" ] || return 1
	probe="${1%/}/.cslite_wr_$$"
	if ( : > "$probe" ) 2>/dev/null; then
		rm -f "$probe" 2>/dev/null || true
		return 0
	fi
	return 1
}

is_termux() {
	[ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ] || [ -d /data/data/com.termux ]
}

detect_os() {
	if is_termux || command -v getprop >/dev/null 2>&1 || [ -x /system/bin/getprop ]; then
		printf 'android'
		return 0
	fi
	if [ -f /etc/openwrt_release ] || { [ -x /sbin/procd ] && [ ! -d /run/systemd/system ]; }; then
		printf 'openwrt'
		return 0
	fi
	case "$(uname -s 2>/dev/null || echo Linux)" in
		Darwin*) printf 'macos' ;;
		Linux*) printf 'linux' ;;
		*) echo "Unsupported OS: $(uname -s 2>/dev/null || echo unknown)" >&2; exit 1 ;;
	esac
}

detect_arch() {
	m="$(uname -m 2>/dev/null || echo amd64)"
	case "$m" in
		x86_64|amd64) printf 'amd64' ;;
		aarch64|arm64|armv8*) printf 'arm64' ;;
		armv7*|armhf|armv6*|arm*) printf 'armv7' ;;
		mipsel*|mips*el|mips64el*) printf 'mipsle' ;;
		mips*)
			if [ -f /etc/openwrt_release ] && grep -qi 'mipsel' /etc/openwrt_release 2>/dev/null; then
				printf 'mipsle'
			else
				printf 'mips'
			fi
			;;
		*) printf '%s' "$m" ;;
	esac
}

is_http_only_wget() {
	tool="$1"
	help_out="$("$tool" --help </dev/null 2>&1 || true)"
	case "$help_out" in
		*"Retrieve files via HTTP or FTP"*) return 0 ;;
	esac
	case "$help_out" in
		*--https*|*--ca-certificate*|*--no-check-certificate*) return 1 ;;
	esac
	case "$help_out" in
		*BusyBox*|*"Usage: wget"*|*"Usage: uclient-fetch"*) return 0 ;;
	esac
	return 1
}

find_openssl_bin() {
	for ossl in openssl /usr/bin/openssl; do
		case "$ossl" in
			/*) [ -x "$ossl" ] && { printf '%s' "$ossl"; return 0; } ;;
			*) command -v "$ossl" >/dev/null 2>&1 && { command -v "$ossl"; return 0; } ;;
		esac
	done
	return 1
}

probe_downloader() {
	if [ -n "${CSLITE_DOWNLOADER:-}" ]; then
		printf '%s' "$CSLITE_DOWNLOADER"
		return 0
	fi
	for tool in curl /system/bin/curl; do
		if command -v "$tool" >/dev/null 2>&1 || [ -x "$tool" ]; then
			printf '%s' "$tool"
			return 0
		fi
	done
	http_only_wget=""
	for tool in wget /system/bin/wget; do
		if command -v "$tool" >/dev/null 2>&1 || [ -x "$tool" ]; then
			if is_http_only_wget "$tool"; then
				[ -z "$http_only_wget" ] && http_only_wget="$tool"
			else
				printf '%s' "$tool"
				return 0
			fi
		fi
	done
	if command -v uclient-fetch >/dev/null 2>&1; then
		printf 'uclient-fetch'
		return 0
	fi
	if ossl_bin="$(find_openssl_bin)"; then
		printf '%s' "$ossl_bin"
		return 0
	fi
	for bb in /data/adb/magisk/busybox /data/adb/ksu/bin/busybox /data/adb/ap/bin/busybox; do
		if [ -x "$bb" ]; then
			printf 'busybox:%s' "$bb"
			return 0
		fi
	done
	if [ -n "$http_only_wget" ]; then
		printf '%s' "$http_only_wget"
		return 0
	fi
	echo "Error: curl, wget, uclient-fetch, or openssl is required." >&2
	exit 1
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

resolve_redirect_url() {
	loc="$1"
	case "$loc" in
		http://*|https://*)
			printf '%s' "$loc"
			return 0
			;;
		//*)
			printf '%s:%s' "$URL_SCHEME" "$loc"
			return 0
			;;
	esac
	origin_host="$URL_HOST"
	case "$origin_host" in
		*:*) origin_host="[${origin_host}]" ;;
	esac
	if { [ "$URL_SCHEME" = "https" ] && [ "$URL_PORT" = "443" ]; } || \
	   { [ "$URL_SCHEME" = "http" ] && [ "$URL_PORT" = "80" ]; }; then
		origin="${URL_SCHEME}://${origin_host}"
	else
		origin="${URL_SCHEME}://${origin_host}:${URL_PORT}"
	fi
	case "$loc" in
		/*)
			printf '%s%s' "$origin" "$loc"
			;;
		*)
			base_dir="${URL_PATH%%\?*}"
			case "$base_dir" in
				*/*) base_dir="${base_dir%/*}/" ;;
				*) base_dir="/" ;;
			esac
			printf '%s%s%s' "$origin" "$base_dir" "$loc"
			;;
	esac
}

write_http_get() {
	printf 'GET %s HTTP/1.1\r\nHost: %s\r\nUser-Agent: cslite-installer\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n' \
		"$1" "$2"
}

openssl_fetch() {
	cur_url="$1"
	dest="$2"
	ossl_bin="$3"
	hop=0

	while :; do
		if ! parse_http_url "$cur_url"; then
			return 1
		fi
		raw_f="${dest}.raw.$$"
		rm -f "$raw_f" "$dest"

		echo "Fetching ${cur_url} via ${ossl_bin}..." >&2
		trc=0
		if [ "$URL_SCHEME" = "https" ]; then
			connect_host="$URL_HOST"
			case "$connect_host" in
				*:*) connect_host="[${connect_host}]" ;;
			esac
			write_http_get "$URL_PATH" "$URL_HOST_HDR" | \
				"$ossl_bin" s_client -quiet -ign_eof -connect "${connect_host}:${URL_PORT}" -servername "$URL_HOST" >"$raw_f" 2>/dev/null || trc=$?
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
				rm -f "$raw_f"
				return 1
			fi
			write_http_get "$URL_PATH" "$URL_HOST_HDR" | \
				"$nc_bin" "$URL_HOST" "$URL_PORT" >"$raw_f" 2>/dev/null || trc=$?
		else
			rm -f "$raw_f"
			return 1
		fi

		if [ ! -s "$raw_f" ]; then
			rm -f "$raw_f"
			return 1
		fi

		meta="$(LC_ALL=C awk -v out_f="$dest" '
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
			loc = ""
			cstate = "size"
			chunk_rem = 0
			chunk_done = 0
			want_body = 0
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
						loc = ""
						next
					}
					in_body = 1
					want_body = (status >= 200 && status < 300) ? 1 : 0
					if (!chunked || !want_body) {
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
					} else if (index(low, "location:") == 1) {
						loc = substr(clean, 10)
						sub(/^[ \t]+/, "", loc)
						sub(/[ \t]+$/, "", loc)
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
			if (chunked && want_body) close(out_f)
			printf "%d|%d|%d|%d|%s\n", status + 0, chunked + 0, hdr_bytes + 0, chunk_done + 0, loc
		}
		' "$raw_f")" || { rm -f "$raw_f" "$dest"; return 1; }

		status_code=0
		is_chunked=0
		hdr_bytes=0
		chunk_done=0
		redir_loc=""
		IFS='|' read -r status_code is_chunked hdr_bytes chunk_done redir_loc <<EOF || true
$meta
EOF

		case "$status_code" in
			301|302|303|307|308)
				rm -f "$raw_f" "$dest"
				[ -n "$redir_loc" ] || return 1
				hop=$((hop + 1))
				[ "$hop" -le 5 ] || return 1
				cur_url="$(resolve_redirect_url "$redir_loc")"
				continue
				;;
			''|*[!0-9]*|0)
				rm -f "$raw_f" "$dest"
				return 1
				;;
		esac

		if [ "$status_code" -ge 200 ] && [ "$status_code" -lt 300 ]; then
			if [ "$is_chunked" -eq 1 ]; then
				if [ "$chunk_done" -ne 1 ]; then
					rm -f "$raw_f" "$dest"
					return 1
				fi
			else
				{ dd bs=1 count="$hdr_bytes" >/dev/null 2>&1; cat; } < "$raw_f" > "$dest" || { rm -f "$raw_f" "$dest"; return 1; }
			fi
			rm -f "$raw_f"
			return 0
		fi

		rm -f "$raw_f" "$dest"
		return 1
	done
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

	rc=0
	case "$tool" in
		curl|/system/bin/curl)
			if [ -n "$timeout_sec" ]; then
				"$tool" -fsSL --connect-timeout 6 -m "$timeout_sec" -o "$dest" "$src" || rc=$?
			else
				"$tool" -fsSL -o "$dest" "$src" || rc=$?
			fi
			return "$rc"
			;;
		openssl|/usr/bin/openssl|*/openssl)
			openssl_fetch "$src" "$dest" "$tool" || rc=$?
			return "$rc"
			;;
		wget|/system/bin/wget|uclient-fetch)
			if [ -n "$wget_timeout" ]; then
				flags_spec="$(probe_wget_timeout_flags "$tool")"
				set -- -q
				[ "${flags_spec%%:*}" = "1" ] && set -- "$@" -T "$wget_timeout"
				[ "${flags_spec#*:}" = "1" ] && set -- "$@" -t 1
				"$tool" "$@" -O "$dest" "$src" || rc=$?
			else
				"$tool" -q -O "$dest" "$src" || rc=$?
			fi
			;;
		busybox:*)
			bb="${tool#busybox:}"
			if [ -n "$wget_timeout" ]; then
				flags_spec="$(probe_wget_timeout_flags "$bb" wget)"
				set -- wget -q
				[ "${flags_spec%%:*}" = "1" ] && set -- "$@" -T "$wget_timeout"
				[ "${flags_spec#*:}" = "1" ] && set -- "$@" -t 1
				"$bb" "$@" -O "$dest" "$src" || rc=$?
			else
				"$bb" wget -q -O "$dest" "$src" || rc=$?
			fi
			;;
		*) return 1 ;;
	esac

	if [ "$rc" -ne 0 ]; then
		case "$src" in
			https://*)
				if ossl_fb="$(find_openssl_bin)"; then
					openssl_fetch "$src" "$dest" "$ossl_fb"
					return $?
				fi
				;;
		esac
	fi
	return "$rc"
}

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

install_android() {
	sh_bin="$(resolve_shell_bin)"
	if is_termux; then
		android_env="termux"
		prefix_dir="${PREFIX:-/data/data/com.termux/files/usr}"
		home_dir="${HOME:-/data/data/com.termux/files/home}"
		install_dir="${CSLITE_INSTALL_DIR:-${prefix_dir}/bin}"
		cfg_dir="${CSLITE_CONFIG_DIR:-${home_dir}/.config/cslite-agent}"
		boot_hook="${home_dir}/.termux/boot/cslite-agent.sh"
	elif [ -d /data/adb ] && [ -w /data/adb ]; then
		android_env="root-magisk"
		install_dir="${CSLITE_INSTALL_DIR:-/data/adb/cslite-agent}"
		cfg_dir="${CSLITE_CONFIG_DIR:-/data/adb/cslite-agent}"
		boot_hook="/data/adb/service.d/99-cslite-agent.sh"
	else
		android_env="adb-tmp"
		install_dir="${CSLITE_INSTALL_DIR:-/data/local/tmp/cslite-agent}"
		cfg_dir="${CSLITE_CONFIG_DIR:-/data/local/tmp/cslite-agent}"
		boot_hook=""
	fi

	mkdir -p "$install_dir" "$cfg_dir"
	tmp_dl="${TMP_DIR}/cslite-dl.$$"
	trap 'rm -f "$tmp_dl"' EXIT INT TERM

	mode=""
	install_bin=""
	if [ "$LITE_MODE" -eq 0 ]; then
		try_url="$BIN_URL"
		if [ -z "$try_url" ]; then
			if [ "$VERSION" = "latest" ]; then
				try_url="https://github.com/${REPO_DEFAULT}/releases/latest/download/cslite-agent-linux-${ARCH}"
			else
				try_url="https://github.com/${REPO_DEFAULT}/releases/download/${VERSION}/cslite-agent-linux-${ARCH}"
			fi
		fi
		echo "Downloading cslite-agent (android/${ARCH}, env=${android_env}) from ${try_url}..."
		if fetch_file "$try_url" "$tmp_dl" "$DL_TOOL" 20 2>/dev/null && verify_binary_magic "$tmp_dl" "android"; then
			install_bin="${install_dir}/cslite-agent"
			chmod 0755 "$tmp_dl"
			mv "$tmp_dl" "$install_bin"
			mode="full"
		else
			echo "Go binary release not available at ${try_url}; using server-hosted lite agent..."
			rm -f "$tmp_dl"
			LITE_MODE=1
		fi
	fi

	if [ "$LITE_MODE" -eq 1 ]; then
		fetch_lite_script "$tmp_dl"
		if [ ! -x /bin/sh ] && [ -n "$sh_bin" ]; then
			sed "1s|^#!/bin/sh|#!${sh_bin}|" "$tmp_dl" > "${tmp_dl}.shebang"
			mv "${tmp_dl}.shebang" "$tmp_dl"
		fi
		install_bin="${install_dir}/cslite-agent-lite"
		chmod 0755 "$tmp_dl"
		mv "$tmp_dl" "$install_bin"
		mode="lite"
	fi

	cfg_file="${cfg_dir}/config.json"
	log_file="${cfg_dir}/cslite-agent.log"
	pid_file="${TMP_DIR}/cslite-agent.pid"
	lite_pid_file="${TMP_DIR}/cslite-agent-lite.pid"
	write_config_json "$cfg_file"

	if [ "${CSLITE_SKIP_SERVICE_EXEC:-0}" = "1" ]; then
		echo "Installed ${mode} agent to ${install_bin} (config: ${cfg_file}); skipped service start (CSLITE_SKIP_SERVICE_EXEC=1)."
		return 0
	fi

	if [ -n "$boot_hook" ]; then
		mkdir -p "$(dirname "$boot_hook")"
		if [ "$android_env" = "termux" ]; then
			cat > "$boot_hook" <<EOF
#!${sh_bin}
termux-wake-lock >/dev/null 2>&1 || true
export CSLITE_CONFIG_DIR="${cfg_dir}"
if [ -f "${pid_file}" ] && kill -0 "\$(cat "${pid_file}" 2>/dev/null)" 2>/dev/null; then
	exit 0
fi
EOF
			if [ "$mode" = "lite" ]; then
				printf 'nohup "%s" "%s" run --config "%s" >"%s" 2>&1 </dev/null &\n' "$sh_bin" "$install_bin" "$cfg_file" "$log_file" >> "$boot_hook"
			else
				printf 'nohup "%s" run --config "%s" >"%s" 2>&1 </dev/null &\n' "$install_bin" "$cfg_file" "$log_file" >> "$boot_hook"
			fi
			printf 'echo $! > "%s"\n' "$pid_file" >> "$boot_hook"
		else
			cat > "$boot_hook" <<EOF
#!${sh_bin}
(
	i=0
	while [ "\$i" -lt 30 ]; do
		[ "\$(getprop sys.boot_completed 2>/dev/null)" = "1" ] && break
		sleep 2
		i=\$((i + 1))
	done
	export CSLITE_CONFIG_DIR="${cfg_dir}"
	if [ -f "${pid_file}" ] && kill -0 "\$(cat "${pid_file}" 2>/dev/null)" 2>/dev/null; then
		exit 0
	fi
EOF
			if [ "$mode" = "lite" ]; then
				printf '\t"%s" "%s" run --config "%s" >"%s" 2>&1 </dev/null &\n' "$sh_bin" "$install_bin" "$cfg_file" "$log_file" >> "$boot_hook"
			else
				printf '\t"%s" run --config "%s" >"%s" 2>&1 </dev/null &\n' "$install_bin" "$cfg_file" "$log_file" >> "$boot_hook"
			fi
			cat >> "$boot_hook" <<EOF
	echo \$! > "${pid_file}"
) &
EOF
		fi
		chmod 0755 "$boot_hook"
	fi

	stop_pid_file "$pid_file"
	stop_pid_file "$lite_pid_file"

	export CSLITE_CONFIG_DIR="$cfg_dir"
	if [ "$mode" = "lite" ]; then
		if command -v nohup >/dev/null 2>&1; then
			nohup "$sh_bin" "$install_bin" run --config "$cfg_file" >"$log_file" 2>&1 </dev/null &
		else
			"$sh_bin" "$install_bin" run --config "$cfg_file" >"$log_file" 2>&1 </dev/null &
		fi
	else
		if command -v nohup >/dev/null 2>&1; then
			nohup "$install_bin" run --config "$cfg_file" >"$log_file" 2>&1 </dev/null &
		else
			"$install_bin" run --config "$cfg_file" >"$log_file" 2>&1 </dev/null &
		fi
	fi
	ag_pid=$!
	printf '%s\n' "$ag_pid" > "$pid_file"

	sleep 1
	if kill -0 "$ag_pid" 2>/dev/null; then
		echo "cslite-agent (${mode}, android/${ARCH}) started (pid=${ag_pid})"
	else
		echo "Warning: agent process exited early; check log at ${log_file}" >&2
	fi
	echo "  Binary: ${install_bin}"
	echo "  Config: ${cfg_file}"
	echo "  Log:    ${log_file}"
	[ -n "$boot_hook" ] && echo "  Boot:   ${boot_hook}" || true
}

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
	if [ "$is_lite" -eq 1 ]; then
		nohup "$sh_bin" "$bin_path" run --config "$cfg_file" >"$log_file" 2>&1 </dev/null &
	else
		nohup "$bin_path" run --config "$cfg_file" >"$log_file" 2>&1 </dev/null &
	fi
	ag_pid=$!
	printf '%s\n' "$ag_pid" > "$pid_file"
	echo "Started cslite-agent in background (pid=${ag_pid}, log=${log_file})"
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
				if systemctl --user daemon-reload && systemctl --user enable --now cslite-agent; then
					echo "Installed and started user systemd service cslite-agent (${INSTALL_BIN})"
					exit 0
				fi
				echo "systemd --user unavailable; falling back to background process..."
				start_nohup_fallback "$INSTALL_BIN" "$CFG_DIR" "$CFG_FILE" 1 "$SH_BIN"
			else
				systemctl daemon-reload
				systemctl enable --now cslite-agent
				echo "Installed and started systemd service cslite-agent (${INSTALL_BIN})"
			fi
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
