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

