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

