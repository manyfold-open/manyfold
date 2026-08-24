#!/bin/sh
# mf CLI installer (POSIX sh).
#
# Resolves a release manifest, then downloads and verifies the artifact it
# names. The manifest — not a filename convention — is the contract, so this
# script never builds a download URL and needs no GitHub API call (and is
# therefore not subject to its rate limit).
#
# Usage:
#   curl -fsSL https://manyfold.ai/cli/install.sh | sh
#   curl -fsSL https://manyfold.ai/cli/install.sh | sh -s -- setup
#   curl -fsSL https://manyfold.ai/cli/install.sh | VERSION=0.24.0 sh
#   curl -fsSL https://manyfold.ai/cli/install.sh | MF_INSTALL_DIR=/usr/local/bin sh
#   curl -fsSL https://manyfold.ai/cli/install.sh | MF_CHANNEL=dev sh
#
# Also served from the source tree:
#   curl -fsSL https://raw.githubusercontent.com/manyfold-open/manyfold/main/apps/cli/install.sh | sh

set -eu

REPO="manyfold-open/manyfold"
DOWNLOAD_BASE="https://github.com/$REPO/releases/download"
CHANNEL_TAG="cli-channels"
DEV_TAG="cli-dev"
RELEASES_URL="https://github.com/$REPO/releases"
ISSUES_URL="https://github.com/$REPO/issues"
INSTALL_DIR="${MF_INSTALL_DIR:-$HOME/.local/bin}"

err() { printf 'install: error: %s\n' "$1" >&2; exit 1; }
log() { printf 'install: %s\n' "$1"; }

# `staging` is the pre-rename alias for the dev channel.
CHANNEL="${MF_CHANNEL:-stable}"
case "$CHANNEL" in
    dev|staging) CHANNEL=dev ;;
    stable) ;;
    *) err "unknown channel '$CHANNEL' (expected stable or dev)" ;;
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

# Extractors for the manifest emitted by apps/cli/scripts/build-manifest.mjs.
# That writer uses JSON.stringify(m, null, 2) with a fixed key order, so
# top-level fields sit at 2 spaces, artifact keys at 4 and their fields at 6.
# Both sides assert that layout (test/install-script.test.ts and
# test/release-manifest.test.ts) precisely because this parser depends on it.
manifest_field() {
    printf '%s\n' "$1" | awk -v k="$2" '
        index($0, "\"" k "\": \"") {
            sub(/^[^:]*: *"/, "")
            sub(/",?[ ]*$/, "")
            print
            exit
        }'
}

artifact_field() {
    printf '%s\n' "$1" | awk -v t="$2" -v f="$3" '
        index($0, "\"" t "\": {") { inblk = 1; next }
        inblk && index($0, "\"" f "\": ") {
            sub(/^[^:]*: *"?/, "")
            sub(/"?,?[ ]*$/, "")
            print
            exit
        }
        inblk && /^ {4}}/ { inblk = 0 }'
}

# VERSION pins one immutable build; otherwise follow the channel pointer. A dev
# version resolves inside the rolling dev release, a bare semver inside its own
# cli-v* release.
if [ -n "${VERSION:-}" ]; then
    case "$VERSION" in
        *-dev.*|*-staging.*)
            manifest_url="$DOWNLOAD_BASE/$DEV_TAG/manifest-${VERSION}.json" ;;
        *)
            manifest_url="$DOWNLOAD_BASE/cli-v${VERSION#v}/manifest.json" ;;
    esac
else
    manifest_url="$DOWNLOAD_BASE/$CHANNEL_TAG/$CHANNEL.json"
fi

manifest=$(curl -fsSL --retry 3 "$manifest_url" 2>/dev/null) \
    || err "could not read $manifest_url (version missing, or a network problem)"

version=$(manifest_field "$manifest" version)
[ -n "$version" ] || err "no version in $manifest_url"
url=$(artifact_field "$manifest" "$target" url)
sha=$(artifact_field "$manifest" "$target" sha256)
[ -n "$url" ] || err "the $CHANNEL channel has no $target build for $version; see $RELEASES_URL"
[ -n "$sha" ] || err "no sha256 for the $target build of $version in $manifest_url"
asset=$(basename "$url")

log "platform=${target}  channel=${CHANNEL}  cli=${version}"
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

    # Compare against the manifest's own value rather than a detached .sha256:
    # that sibling could be served from a different cache generation than the
    # archive it describes.
    log "verifying sha256…"
    computed=$(
        (shasum -a 256 "$tmp/$asset" 2>/dev/null || sha256sum "$tmp/$asset") \
            | awk '{ print $1 }'
    )
    [ -n "$computed" ] || err "no sha256 tool available (need shasum or sha256sum)"
    [ "$computed" = "$sha" ] \
        || err "sha256 mismatch (expected $sha, got $computed)"

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
