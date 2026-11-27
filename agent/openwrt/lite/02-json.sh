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

