---
title: CLI and daemons on a self-hosted deployment
description: Install the mf CLI against your own Manyfold deployment, register a machine as a runtime, and keep both up to date.
order: 2
---

# CLI and daemons on a self-hosted deployment

The `mf` binary is the same one everyone runs — there is no separate
self-hosted build. What differs is where it points: out of the box it talks to
the hosted API at `api.manyfold.ai`, so a self-hosted deployment has to say so
once, explicitly.

That single fact is most of this page. Registering a machine, autostart and
framework detection then work exactly as documented for the hosted service.

## Install

```sh
curl -fsSL https://manyfold.ai/cli/install.sh | sh
```

This installs `mf` to `~/.local/bin` and nothing else — it does not sign you in
or contact any API. See [Install the CLI](../install/) for Windows, choosing a
different directory, and pinning a version.

The installer downloads from the public releases of `manyfold-open/manyfold`,
the same source your deployment is built from, so it behaves the same whether
or not your API is reachable from the machine running it.

## Point the CLI at your deployment

Sign in with `--api-url`, once:

```sh
mf login --api-url https://<your-api>/api
```

The URL is pinned into the profile at sign-in, so every later command —
`mf agent list`, `mf daemon register`, all of them — uses it without repeating
the flag. Confirm with:

```sh
mf whoami
mf profile show
```

`mf profile show` prints the `apiUrl` the profile resolved. If it reads
`https://api.manyfold.ai/api (channel default; pinned at login)`, the sign-in
did not pin your URL and the CLI is pointed at the hosted service.

**Do not run a bare `mf login` on a self-hosted install.** With no `--api-url`
and nothing stored, the CLI falls back to the hosted API and signs you into the
wrong place. The resolution order is `--api-url` on the command, then the
profile's stored URL, then the built-in default.

`MF_API_URL` sets the same thing by environment, which suits a shell profile or
a provisioning script:

```sh
export MF_API_URL=https://<your-api>/api
```

### Keep it separate from a hosted login

If you also use the hosted service from the same machine, give the deployment
its own [profile](../profiles/) rather than overwriting the default one. A
profile exists as soon as you name it:

```sh
mf --profile selfhost login --api-url https://<your-api>/api
mf --profile selfhost whoami
```

Profiles isolate credentials, daemon registration and daemon state, so the two
never collide. Set `MF_PROFILE=selfhost` to stop repeating the flag.

## Register a machine as a runtime

A self-hosted deployment brings no execution environment of its own, so until
you attach a runtime there is nowhere for agents to run. The usual answer is
the daemon: `mf` runs in the background on a machine you own and takes agent
sessions on demand.

One command covers the whole flow — sign in, issue a machine token, register,
install autostart, and wait for the daemon to report healthy:

```sh
mf setup --api-url https://<your-api>/api
```

Over SSH, add `--no-launch-browser` and approve from a browser on any other
machine.

When an administrator issues the token for you, use the manual path instead.
In your deployment's web app, open **Settings → Self-owned computers** and
issue a token, then on the target machine:

```sh
mf daemon register --token ldt_xxxxxxxxxxxxxxxxxxxxxxxxxx
```

`mf daemon register` uses the API URL already stored in the profile, so sign in
first and it needs no `--api-url` of its own. Read the `apiUrl:` line it prints
before answering the start prompt — that is the last chance to notice a
registration heading somewhere unintended.

[Register a self-owned computer](../local-daemons/) covers verification,
autostart, framework detection and revocation in full. All of it applies here
unchanged.

## Updates

`mf update` follows the public release channels whichever deployment you are
signed into, because the CLI and the deployment version independently:

```sh
mf update --check
mf update
```

The daemon does not update itself on a self-hosted deployment. Background
auto-update turns itself on only when the daemon's API URL is the hosted
default, so a custom URL leaves it off and nothing swaps the binary under a
deployment whose compatible version you control. Opt in per machine:

```sh
MF_DAEMON_AUTO_UPDATE=1 mf daemon start
```

`mf daemon status` shows whether auto-update is on for that machine.

Keep the CLI reasonably close to the deployment. An administrator can set a
minimum CLI version, and new API features generally need a CLI that knows about
them, so upgrading the stack and running `mf update` on your daemon machines
belong to the same maintenance pass.

## Checking what you are running

```sh
mf version --verbose
```

reports the version, update channel, source commit, build time, platform
target, install method, and which profile and config directory are in play —
the fastest way to confirm a machine is on the binary and the deployment you
expect.

```sh
mf profile show      # resolved apiUrl and login state for this profile
mf profile list      # every profile on this machine
mf daemon status     # local daemon: running, version, auto-update
```

## Troubleshooting

**`mf whoami` fails, or the account looks empty.** Almost always a CLI signed
into the hosted API instead of your deployment. Run `mf profile show`; if
`apiUrl` is not yours, sign in again with `--api-url`.

**`mf daemon register` says the daemon token does not exist.** Your deployment
issued the token but the CLI presented it somewhere else — same cause, same
fix. The `apiUrl:` line in the register output says where it went.

**The daemon registers but the dashboard shows it offline.** The API needs
WebSocket forwarding. A reverse proxy that terminates TLS without upgrading
connections lets registration succeed and then blocks the daemon's socket; see
the serving section of [Self-hosting](../self-hosting/).

**The daemon connects but detects no coding agent.** Detection looks for
`claude`, `codex` and `gemini` on the daemon's `PATH`, and a daemon started by
an autostart unit does not inherit an interactive shell's `PATH`. Run
`mf daemon doctor`, which reports what it found and where it looked.
