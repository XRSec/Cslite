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

