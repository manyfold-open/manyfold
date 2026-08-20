#!/bin/sh
# mf CLI installer (POSIX sh) — open-source edition.
# Downloads the newest mf binary from this repository's GitHub Releases.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/manyfold-open/manyfold/main/apps/cli/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/manyfold-open/manyfold/main/apps/cli/install.sh | sh -s -- setup
#   curl -fsSL https://raw.githubusercontent.com/manyfold-open/manyfold/main/apps/cli/install.sh | VERSION=0.1.0 sh
#   curl -fsSL https://raw.githubusercontent.com/manyfold-open/manyfold/main/apps/cli/install.sh | MF_INSTALL_DIR=/usr/local/bin sh

set -eu

REPO="manyfold-open/manyfold"
API="https://api.github.com/repos/$REPO/releases"
RELEASES_URL="https://github.com/$REPO/releases"
ISSUES_URL="https://github.com/$REPO/issues"
INSTALL_DIR="${MF_INSTALL_DIR:-$HOME/.local/bin}"

err() { printf 'install: error: %s\n' "$1" >&2; exit 1; }
log() { printf 'install: %s\n' "$1"; }

# The open-source releases have a single channel; the dev/staging channel of
# the hosted platform's CDN installer does not exist here.
case "${MF_CHANNEL:-stable}" in
    stable) ;;
    *) err "unknown channel '${MF_CHANNEL}' (the open-source installer only has stable releases)" ;;
esac

uname_s=$(uname -s | tr '[:upper:]' '[:lower:]')
uname_m=$(uname -m)

case "$uname_s" in
    linux)  os=linux ;;
    darwin) os=darwin ;;
    *)      err "unsupported OS '$uname_s' (this script handles linux/darwin; for windows download from $RELEASES_URL)" ;;
esac

case "$uname_m" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) err "unsupported arch '$uname_m'" ;;
esac

target="${os}-${arch}"

# VERSION picks a release tag (with or without the leading v); default is the
# latest release. Asset names embed the CLI's own version, so it is recovered
# from the matching asset URL rather than assumed equal to the tag.
if [ -n "${VERSION:-}" ]; then
    tag="v${VERSION#v}"
    release_api="$API/tags/$tag"
else
    release_api="$API/latest"
fi

release_json=$(curl -fsSL --retry 3 -H 'accept: application/vnd.github+json' "$release_api" 2>/dev/null) \
    || err "could not read $release_api (release missing, or GitHub API rate limit — try again shortly)"
tag=$(printf '%s' "$release_json" \
    | grep -o '"tag_name": *"[^"]*"' | head -n 1 | cut -d'"' -f4)
url=$(printf '%s' "$release_json" \
    | grep -o '"browser_download_url": *"[^"]*"' | cut -d'"' -f4 \
    | grep "/mf-.*-${target}\.tar\.gz$" | head -n 1)
[ -n "$url" ] || err "release ${tag:-?} has no asset for ${target}; see $RELEASES_URL"
asset=$(basename "$url")
cli_version=${asset#mf-}
cli_version=${cli_version%"-${target}.tar.gz"}
sum_url="${url}.sha256"

log "platform=${target}  release=${tag}  cli=${cli_version}"
log "url=${url}"

installed_version=""
if [ -x "$INSTALL_DIR/mf" ]; then
    installed_version=$("$INSTALL_DIR/mf" --version 2>/dev/null || true)
    installed_version=$(printf '%s' "$installed_version" | tr -d '\r\n ')
fi

if [ "$installed_version" = "$cli_version" ]; then
    log "already installed: $INSTALL_DIR/mf ($cli_version); skipping download"
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
