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
