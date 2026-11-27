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

