#!/bin/sh
# mf CLI installer (POSIX sh).
# Usage:
#   curl -fsSL https://cdn1.manyfold.ai/cli/install.sh | sh
#   curl -fsSL https://cdn1.manyfold.ai/cli/install.sh | sh -s -- setup
#   curl -fsSL https://cdn1.manyfold.ai/cli/install.sh | VERSION=0.1.0 sh
#   curl -fsSL https://cdn1.manyfold.ai/cli/install.sh | MF_INSTALL_DIR=/usr/local/bin sh
#   curl -fsSL https://cdn1.manyfold.ai/cli/install.sh | MF_CHANNEL=dev sh

set -eu

CDN="https://cdn1.manyfold.ai/cli"
ISSUES_URL="https://github.com/protagolabs/manyfold/issues"
INSTALL_DIR="${MF_INSTALL_DIR:-$HOME/.local/bin}"

err() { printf 'install: error: %s\n' "$1" >&2; exit 1; }
log() { printf 'install: %s\n' "$1"; }

# Single line below is the sed anchor for the staging release workflow.
CHANNEL="${MF_CHANNEL:-stable}"
case "$CHANNEL" in
    dev|staging) CHANNEL="dev"; CDN="$CDN/staging" ;;
    stable) ;;
    *) err "unknown channel '$CHANNEL' (expected dev or stable)" ;;
esac

uname_s=$(uname -s | tr '[:upper:]' '[:lower:]')
uname_m=$(uname -m)

case "$uname_s" in
    linux)  os=linux ;;
    darwin) os=darwin ;;
    *)      err "unsupported OS '$uname_s' (this script handles linux/darwin; for windows download from $CDN/latest/)" ;;
esac

case "$uname_m" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) err "unsupported arch '$uname_m'" ;;
esac

target="${os}-${arch}"

resolve_version() {
    if [ -n "${VERSION:-}" ]; then
        printf '%s' "$VERSION"
        return
    fi
    v=$(curl -fsSL "$CDN/latest/version.txt" 2>/dev/null | tr -d '\r\n ')
    [ -n "$v" ] || err "could not resolve latest version from $CDN/latest/version.txt; pass VERSION=x.y.z"
    printf '%s' "$v"
}

version=$(resolve_version)
asset="mf-${version}-${target}.tar.gz"
url="$CDN/v${version}/${asset}"
sum_url="${url}.sha256"

log "platform=${target}  version=${version}  channel=${CHANNEL}"
log "url=${url}"

installed_version=""
if [ -x "$INSTALL_DIR/mf" ]; then
    installed_version=$("$INSTALL_DIR/mf" --version 2>/dev/null || true)
    installed_version=$(printf '%s' "$installed_version" | tr -d '\r\n ')
fi

if [ "$installed_version" = "$version" ]; then
    log "already installed: $INSTALL_DIR/mf ($version); skipping download"
else
    tmp=$(mktemp -d 2>/dev/null || mktemp -d -t mf-install)
    cleanup() { rm -rf "$tmp"; }
    trap cleanup EXIT INT TERM

    log "downloading…"
    curl -fsSL --retry 3 -o "$tmp/$asset" "$url" || err "download failed: $url"
    curl -fsSL --retry 3 -o "$tmp/$asset.sha256" "$sum_url" || err "checksum fetch failed: $sum_url"

    log "verifying sha256…"
    (cd "$tmp" && shasum -a 256 -c "$asset.sha256" >/dev/null 2>&1) \
        || (cd "$tmp" && sha256sum -c "$asset.sha256" >/dev/null 2>&1) \
        || err "sha256 verify failed"

    log "extracting to $INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"
    tar -xzf "$tmp/$asset" -C "$tmp"
    [ -f "$tmp/mf" ] || err "tarball did not contain 'mf' binary"
    mv "$tmp/mf" "$INSTALL_DIR/mf"
    chmod +x "$INSTALL_DIR/mf"

    log "installed: $INSTALL_DIR/mf"
    "$INSTALL_DIR/mf" --version >/dev/null 2>&1 \
        || err "installed binary failed to run; report at $ISSUES_URL"
    cleanup
    trap - EXIT INT TERM
fi

case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
        printf '\n'
        log "note: $INSTALL_DIR is not in your PATH"
        log "  add this to your shell rc file:"
        printf '    export PATH="%s:$PATH"\n\n' "$INSTALL_DIR"
        ;;
esac

# Forward any trailing args to the freshly installed binary by full path.
# Reattach a controlling terminal when available because stdin contains this
# script when the installer is invoked through a pipe.
if [ "$#" -gt 0 ]; then
    log "running installed mf"
    printf '\n'
    if ( : </dev/tty ) 2>/dev/null; then
        exec "$INSTALL_DIR/mf" "$@" </dev/tty
    fi
    exec "$INSTALL_DIR/mf" "$@" </dev/null
fi

log "done — try: mf --help"
