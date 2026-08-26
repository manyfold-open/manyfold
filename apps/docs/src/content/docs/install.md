---
title: Install the CLI
description: Install, sign in, update, and verify the mf CLI.
order: 2
---
The `mf` CLI is distributed as a standalone binary, so you do not need Node.js for normal use. See the [CLI overview](/docs/cli/) for its agent, runtime, channel, automation, file, backup, skill, usage, A2A, and daemon capabilities.

## macOS and Linux

```sh
curl -fsSL https://manyfold.ai/cli/install.sh | sh -s -- setup
```

This installs `mf`, signs you in, registers the machine, and starts its daemon. To install the CLI without running setup, omit `-s -- setup`.

Before downloading the archive, the installer checks the `mf` binary in the target install directory. If it already matches the selected version, the download is skipped and any requested setup command still runs.

The installer places `mf` in `~/.local/bin` by default. If your shell cannot find it after installation, add this to your shell profile:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

You can choose a different install directory:

```sh
curl -fsSL https://manyfold.ai/cli/install.sh | MF_INSTALL_DIR=/usr/local/bin sh
```

> **Note:** You may need `sudo` for system directories such as `/usr/local/bin`.

## Windows

Download the Windows zip from the manual download path below, extract `mf.exe`, and place it in a directory on your `PATH`.

## Manual download

Every release attaches its assets to a GitHub release:

```text
https://github.com/manyfold-open/manyfold/releases/tag/cli-v<version>
```

Which version each channel currently points at is published as a manifest:

```text
https://github.com/manyfold-open/manyfold/releases/download/cli-channels/stable.json
```

| platform            | asset                          |
| ------------------- | ------------------------------ |
| linux-x64           | `mf-<ver>-linux-x64.tar.gz`    |
| linux-arm64         | `mf-<ver>-linux-arm64.tar.gz`  |
| macos-x64 (Intel)   | `mf-<ver>-darwin-x64.tar.gz`   |
| macos-arm64 (Apple) | `mf-<ver>-darwin-arm64.tar.gz` |
| windows-x64         | `mf-<ver>-windows-x64.zip`     |

Each tarball ships with a sibling `.sha256` for verification, and the manifest above records the same checksum for every asset.

## Sign in

```sh
mf login
mf whoami
mf profile show
```

`mf login` opens a browser-based sign-in flow. If you are on a remote server or cannot launch a browser automatically, run:

```sh
mf login --no-launch-browser
```

The CLI prints a URL and a code, then waits at a `Paste auth code:` prompt. Open the URL in a browser on any machine — your laptop works fine when the CLI is on a remote host — check that the code matches, approve, and paste the authorization code the page shows back into the terminal. The session is valid for 15 minutes.

`mf setup` takes the same flag when you are onboarding a remote machine over SSH:

```sh
mf setup --no-launch-browser
```

Credentials and daemon state are stored in the selected
[CLI profile](/docs/profiles/). Use `--profile <name>` or `MF_PROFILE` when one
machine connects to more than one Manyfold deployment.

## Verify the installation

```sh
mf --version
mf agent list
mf runtime list
mf update --check
```

Use `mf --help` for the top-level command map and `mf <command> --help` for the exact options supported by the installed version.

## Update

```sh
mf update --check
mf update
```

> **Note:** If a local daemon is running, restart it after updating the CLI so it uses the new binary.

### Upgrading from CLI 0.21 or earlier

CLI 0.22 introduced the current profile layout and removed legacy config and
daemon fallbacks. After upgrading, run `mf login` and `mf daemon register`
again in the intended profile. Existing workspaces and the host skill store
under `~/.manyfold` remain in place.

## Next steps

- [Explore the CLI](/docs/cli/)
- [Profiles and environments](/docs/profiles/)
- [Scripting with mf](/docs/scripting/)
- [Register a self-owned computer](/docs/local-daemons/)
