#!/bin/sh
# Build OpenWrt .ipk package (full Go binary or lite POSIX/BusyBox shell agent)
# Compatible with macOS (bsdtar) and Linux (GNU tar) with zero AppleDouble metadata.

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
AGENT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

MODE="full"
PKG_ARCH=""
VERSION=""
if [ -f "$AGENT_DIR/VERSION" ]; then
	VERSION="$(tr -d '[:space:]' < "$AGENT_DIR/VERSION" 2>/dev/null || true)"
fi
[ -n "$VERSION" ] || VERSION="1.2.2"
BIN_PATH=""
OUT_PATH=""

usage() {
	cat <<EOF
Usage: build-ipk.sh [--lite | --full] [--arch <openwrt-arch>] [--bin <binary>] [--version <ver>] [--out <file.ipk>]

Options:
  --lite             Build architecture-independent shell-agent .ipk (arch: all)
  --full             Build Go binary .ipk (default)
  --mode <lite|full> Explicitly select package mode
  --arch <arch>      OpenWrt architecture (e.g. all, x86_64, aarch64_generic, arm_cortex-a7_neon-vfpv4, mips_24kc, mipsel_24kc)
  --bin <path>       Pre-built cslite-agent Linux binary (full mode; auto-built via go if omitted)
  --version <ver>    Package version (default: from agent/VERSION)
  --out <path>       Output .ipk file path
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--lite) MODE="lite"; shift ;;
		--full) MODE="full"; shift ;;
		--mode) MODE="$2"; shift 2 ;;
		--arch) PKG_ARCH="$2"; shift 2 ;;
		--bin) BIN_PATH="$2"; shift 2 ;;
		--version) VERSION="$2"; shift 2 ;;
		--out) OUT_PATH="$2"; shift 2 ;;
		-h|--help) usage; exit 0 ;;
		*) echo "Unknown option: $1" >&2; usage; exit 2 ;;
	esac
done

VERSION="${VERSION#v}"

if [ "$MODE" = "lite" ]; then
	PKG_NAME="cslite-agent-lite"
	[ -z "$PKG_ARCH" ] && PKG_ARCH="all"
elif [ "$MODE" = "full" ]; then
	PKG_NAME="cslite-agent"
	[ -z "$PKG_ARCH" ] && PKG_ARCH="x86_64"
else
	echo "Invalid --mode '$MODE': expected lite or full" >&2
	exit 2
fi

if [ -z "$OUT_PATH" ]; then
	OUT_PATH="./${PKG_NAME}_${VERSION}_${PKG_ARCH}.ipk"
fi
OUT_DIR="$(dirname "$OUT_PATH")"
mkdir -p "$OUT_DIR"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cslite-ipk.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT INT TERM

CTRL_DIR="$WORK_DIR/control"
DATA_DIR="$WORK_DIR/data"
STAGE_DIR="$WORK_DIR/stage"
mkdir -p "$CTRL_DIR" "$DATA_DIR/etc/init.d" "$DATA_DIR/etc/config" "$DATA_DIR/etc/cslite-agent" "$DATA_DIR/usr/bin" "$STAGE_DIR"

# Populate data payload
cp "$SCRIPT_DIR/cslite-agent.init" "$DATA_DIR/etc/init.d/cslite-agent"
chmod 0755 "$DATA_DIR/etc/init.d/cslite-agent"

cp "$SCRIPT_DIR/cslite-agent.uci" "$DATA_DIR/etc/config/cslite-agent"
chmod 0600 "$DATA_DIR/etc/config/cslite-agent"
chmod 0755 "$DATA_DIR/etc/cslite-agent"

if [ "$MODE" = "lite" ]; then
	if [ -d "$SCRIPT_DIR/lite" ]; then
		cat "$SCRIPT_DIR"/lite/[0-9]*.sh > "$DATA_DIR/usr/bin/cslite-agent-lite"
	else
		cp "$SCRIPT_DIR/cslite-agent-lite.sh" "$DATA_DIR/usr/bin/cslite-agent-lite"
	fi
	awk -v ver="v${VERSION}" 'BEGIN{done=0} !done && /^VERSION="/{print "VERSION=\"" ver "\""; done=1; next} {print}' \
		"$DATA_DIR/usr/bin/cslite-agent-lite" > "$DATA_DIR/usr/bin/cslite-agent-lite.tmp"
	mv "$DATA_DIR/usr/bin/cslite-agent-lite.tmp" "$DATA_DIR/usr/bin/cslite-agent-lite"
	chmod 0755 "$DATA_DIR/usr/bin/cslite-agent-lite"
	DEPENDS="+ca-bundle"
	DESC="Cslite ultra-lightweight BusyBox POSIX shell command agent"
else
	if [ -n "$BIN_PATH" ]; then
		[ -f "$BIN_PATH" ] || { echo "Binary not found: $BIN_PATH" >&2; exit 1; }
		cp "$BIN_PATH" "$DATA_DIR/usr/bin/cslite-agent"
	else
		GO_OS="linux"
		GO_ARCH="amd64"
		GO_ARM=""
		GO_MIPS=""
		case "$PKG_ARCH" in
			x86_64|amd64) GO_ARCH="amd64" ;;
			aarch64*|arm64) GO_ARCH="arm64" ;;
			arm*|armv7*) GO_ARCH="arm"; GO_ARM="7" ;;
			mipsel*|mipsle) GO_ARCH="mipsle"; GO_MIPS="softfloat" ;;
			mips*) GO_ARCH="mips"; GO_MIPS="softfloat" ;;
			*) echo "Cannot infer GOARCH from '$PKG_ARCH'; pass --bin <path>" >&2; exit 1 ;;
		esac
		(
			cd "$AGENT_DIR"
			export CGO_ENABLED=0 GOOS="$GO_OS" GOARCH="$GO_ARCH"
			[ -n "$GO_ARM" ] && export GOARM="$GO_ARM"
			[ -n "$GO_MIPS" ] && export GOMIPS="$GO_MIPS"
			go build -trimpath -ldflags="-s -w -X main.Version=v${VERSION}" -o "$DATA_DIR/usr/bin/cslite-agent" .
		)
	fi
	chmod 0755 "$DATA_DIR/usr/bin/cslite-agent"
	DEPENDS="+ca-bundle"
	DESC="Cslite cross-platform command execution agent (Go static binary)"
fi

INSTALLED_SIZE="$(du -sk "$DATA_DIR" | awk '{print $1}')"

cat > "$CTRL_DIR/control" <<EOF
Package: ${PKG_NAME}
Version: ${VERSION}
Depends: ${DEPENDS}
Section: utils
Priority: optional
Architecture: ${PKG_ARCH}
Maintainer: Cslite <noreply@cslite.local>
Installed-Size: ${INSTALLED_SIZE}
Description: ${DESC}
 Manages remote command execution and metrics reporting via Cslite.
EOF

cat > "$CTRL_DIR/conffiles" <<EOF
/etc/config/cslite-agent
EOF

cat > "$CTRL_DIR/postinst" <<'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT:-}" ] || {
	/etc/init.d/cslite-agent enable >/dev/null 2>&1 || true
}
exit 0
EOF
chmod 0755 "$CTRL_DIR/postinst"

cat > "$CTRL_DIR/prerm" <<'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT:-}" ] || {
	/etc/init.d/cslite-agent stop >/dev/null 2>&1 || true
	/etc/init.d/cslite-agent disable >/dev/null 2>&1 || true
}
exit 0
EOF
chmod 0755 "$CTRL_DIR/prerm"

printf '2.0\n' > "$STAGE_DIR/debian-binary"

export COPYFILE_DISABLE=1
export COPY_EXTENDED_ATTRIBUTES_DISABLE=1

make_tgz() {
	src="$1"
	dest="$2"
	shift 2
	if tar --version 2>/dev/null | grep -qi bsdtar; then
		COPYFILE_DISABLE=1 tar --format=ustar --numeric-owner --uid=0 --gid=0 --no-xattrs --no-mac-metadata -czf "$dest" -C "$src" "$@"
	else
		COPYFILE_DISABLE=1 tar --format=ustar --numeric-owner --owner=0 --group=0 -czf "$dest" -C "$src" "$@"
	fi
}

make_tgz "$CTRL_DIR" "$STAGE_DIR/control.tar.gz" .
make_tgz "$DATA_DIR" "$STAGE_DIR/data.tar.gz" .
make_tgz "$STAGE_DIR" "$OUT_PATH" debian-binary control.tar.gz data.tar.gz

echo "Built $OUT_PATH ($(wc -c < "$OUT_PATH" | tr -d ' ') bytes)"
