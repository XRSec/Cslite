#!/bin/sh
# Purpose: Auto-detecting POSIX/BusyBox installer for CSLite Agent (Linux, OpenWrt, macOS, Android).
# Context: Served at /i and /install.sh; assembled cleanly from agent/scripts/install/*.sh.
# Usage: curl -fsSL .../i | sh -s -- <api_key> [device_id] [name]
# Requires: POSIX sh and curl, wget, uclient-fetch, or openssl.

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

