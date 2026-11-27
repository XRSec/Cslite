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

