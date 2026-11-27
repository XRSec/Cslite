#!/bin/sh
# Purpose: Upgrade an installed CSLite agent binary or POSIX lite script in place.
# Context: Served at /u and /upgrade.sh; assembled from upgrade/01, install/02-detect, install/03-http, upgrade/02.
# Usage: upgrade.sh [--server <url>] [--version <tag>] [--bin-url <url>] [--config <path>] [--lite] [--dry-run]
# Requires: POSIX sh, existing CSLite config.json (or --server), and curl/wget/uclient-fetch/openssl.

set -eu

DEFAULT_SERVER="__CSLITE_DEFAULT_SERVER__"
REPO_DEFAULT="XRSec/Cslite"

SERVER="${CSLITE_SERVER:-}"
VERSION="${CSLITE_VERSION:-latest}"
BIN_URL="${CSLITE_BIN_URL:-}"
CFG_FILE="${CSLITE_CONFIG:-}"
FORCE_LITE=0
[ "${CSLITE_LITE:-0}" = "1" ] && FORCE_LITE=1
DRY_RUN=0

usage() {
	cat <<EOF
Usage: upgrade.sh [--server <url>] [--version <tag>] [--bin-url <url>] [--config <path>] [--lite] [--dry-run]
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--server) [ $# -ge 2 ] || { echo "Missing --server value" >&2; exit 2; }; SERVER="$2"; shift 2 ;;
		--server=*) SERVER="${1#*=}"; shift ;;
		--version) [ $# -ge 2 ] || { echo "Missing --version value" >&2; exit 2; }; VERSION="$2"; shift 2 ;;
		--version=*) VERSION="${1#*=}"; shift ;;
		--bin-url) [ $# -ge 2 ] || { echo "Missing --bin-url value" >&2; exit 2; }; BIN_URL="$2"; shift 2 ;;
		--bin-url=*) BIN_URL="${1#*=}"; shift ;;
		--config) [ $# -ge 2 ] || { echo "Missing --config value" >&2; exit 2; }; CFG_FILE="$2"; shift 2 ;;
		--config=*) CFG_FILE="${1#*=}"; shift ;;
		--lite) FORCE_LITE=1; shift ;;
		--dry-run) DRY_RUN=1; shift ;;
		-h|--help) usage; exit 0 ;;
		--) shift ;;
		*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
	esac
done
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
	req_path="$1"
	host_hdr="$2"
	req_ref="${3:-}"
	printf 'GET %s HTTP/1.1\r\nHost: %s\r\nUser-Agent: CSLite-Installer/1.0\r\n' "$req_path" "$host_hdr"
	[ -n "$req_ref" ] && printf 'Referer: %s\r\n' "$req_ref"
	printf 'Accept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n'
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
		ref_hdr=""
		if [ -n "${SERVER_BASE:-}" ]; then
			case "$cur_url" in
				"${SERVER_BASE}/"*) ref_hdr="${SERVER_BASE}/install" ;;
			esac
		fi

		echo "Fetching ${cur_url} via ${ossl_bin}..." >&2
		trc=0
		if [ "$URL_SCHEME" = "https" ]; then
			connect_host="$URL_HOST"
			case "$connect_host" in
				*:*) connect_host="[${connect_host}]" ;;
			esac
			write_http_get "$URL_PATH" "$URL_HOST_HDR" "$ref_hdr" | \
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
			write_http_get "$URL_PATH" "$URL_HOST_HDR" "$ref_hdr" | \
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

probe_wget_has_header() {
	bin="$1"
	subcmd="${2:-}"
	if [ -n "$subcmd" ]; then
		help_out="$("$bin" "$subcmd" --help </dev/null 2>&1 || true)"
	else
		help_out="$("$bin" --help </dev/null 2>&1 || true)"
	fi
	case "$help_out" in
		*--header*) return 0 ;;
		*) return 1 ;;
	esac
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

	ref_hdr=""
	if [ -n "${SERVER_BASE:-}" ]; then
		case "$src" in
			"${SERVER_BASE}/"*) ref_hdr="${SERVER_BASE}/install" ;;
		esac
	fi

	wget_timeout=""
	if [ -n "$timeout_sec" ]; then
		wget_timeout="$timeout_sec"
		[ "$wget_timeout" -gt 10 ] 2>/dev/null && wget_timeout=10
	fi

	rc=0
	case "$tool" in
		curl|/system/bin/curl)
			set -- -fsSL -A "CSLite-Installer/1.0"
			[ -n "$ref_hdr" ] && set -- "$@" -H "Referer: $ref_hdr"
			[ -n "$timeout_sec" ] && set -- "$@" --connect-timeout 6 -m "$timeout_sec"
			"$tool" "$@" -o "$dest" "$src" || rc=$?
			return "$rc"
			;;
		openssl|/usr/bin/openssl|*/openssl)
			openssl_fetch "$src" "$dest" "$tool" || rc=$?
			return "$rc"
			;;
		wget|/system/bin/wget|uclient-fetch)
			set -- -q
			if [ -n "$wget_timeout" ]; then
				flags_spec="$(probe_wget_timeout_flags "$tool")"
				[ "${flags_spec%%:*}" = "1" ] && set -- "$@" -T "$wget_timeout"
				[ "${flags_spec#*:}" = "1" ] && set -- "$@" -t 1
			fi
			if probe_wget_has_header "$tool"; then
				set -- "$@" --header="User-Agent: CSLite-Installer/1.0"
				[ -n "$ref_hdr" ] && set -- "$@" --header="Referer: $ref_hdr"
			fi
			"$tool" "$@" -O "$dest" "$src" || rc=$?
			;;
		busybox:*)
			bb="${tool#busybox:}"
			set -- wget -q
			if [ -n "$wget_timeout" ]; then
				flags_spec="$(probe_wget_timeout_flags "$bb" wget)"
				[ "${flags_spec%%:*}" = "1" ] && set -- "$@" -T "$wget_timeout"
				[ "${flags_spec#*:}" = "1" ] && set -- "$@" -t 1
			fi
			if probe_wget_has_header "$bb" wget; then
				set -- "$@" --header="User-Agent: CSLite-Installer/1.0"
				[ -n "$ref_hdr" ] && set -- "$@" --header="Referer: $ref_hdr"
			fi
			"$bb" "$@" -O "$dest" "$src" || rc=$?
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
