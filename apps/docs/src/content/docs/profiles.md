---
title: Profiles and environments
description: Keep credentials and local daemons for different Manyfold environments separate.
order: 3
---
A profile is the local control-plane state for one Manyfold environment. It
contains that environment's API URL, credential, pending login, daemon
registration, logs, process state, and control socket.

Use profiles when the same machine connects to production, staging, a
[self-hosted deployment](/docs/self-hosting/), or more than one account.

## Select a profile

Selection follows this order:

1. Root option: `--profile <name>`
2. Environment variable: `MF_PROFILE`
3. Binary channel default: `default` for stable, `staging` for dev

```sh
mf --profile default whoami
MF_PROFILE=staging mf whoami
mf profile show
mf profile list
```

Names are 1–32 lowercase letters, digits, `_`, or `-`, starting with a letter
or digit.

## Sign in and register each environment

Login and daemon registration belong to the selected profile:

```sh
mf --profile default login
mf --profile default daemon register --token -

mf --profile staging login --api-url https://api.my-deploy.example/api
mf --profile staging daemon register --token -
```

Each profile gets its own autostart unit, so its daemon can run alongside
other profiles. Use the same profile for `login`, `daemon register`,
`daemon start`, `daemon status`, and `daemon stop`.

## What is isolated

The default layout is:

```text
~/.manyfold/
├── profiles/<name>/
│   ├── config.json
│   ├── pending-login.json
│   └── daemon/
├── workspaces/
├── skills/
└── update-channel.json
```

Profiles isolate credentials and daemon control state. They do **not** isolate:

- Agent workspaces in `~/.manyfold/workspaces`
- The host skill store in `~/.manyfold/skills`
- Framework homes such as `~/.claude` or `~/.codex`
- The installed `mf` binary and its remembered update channel

Agent IDs are globally unique, so profiles can safely share the default data
plane. A host that needs separate storage can declare
`--workspace-root` and `--skills-dir` during `mf daemon register`.

> **Warning:** Never print or copy a profile's `config.json` or daemon files:
> they contain credentials and other sensitive state.

## Inspect or delete a profile

```sh
mf profile show
mf profile show staging --json
mf profile list
mf profile delete staging
```

Deletion removes the profile's credentials, pending login, daemon state, and
init units. It never removes machine-shared agent workspaces or skills. A
running daemon blocks deletion; stop it with the same profile first. Deleting
`default` also requires `--force`.

## Release channels and profiles

`mf update --channel dev|stable` changes the one installed binary and remembers
its update channel at machine scope. It does not move or rewrite profile data.

If you do not set `--profile` or `MF_PROFILE`, switching from a stable binary
to a dev binary changes the default selection from `default` to `staging`.
Run `mf profile show` after switching channels so you know which credentials
and daemon the next command will use.

## Upgrading from CLI 0.21 or earlier

CLI 0.22 removed the old flat config and daemon fallbacks. After upgrading:

1. Select the intended profile.
2. Run `mf login`.
3. Issue a new machine token in **Settings → Self-owned computers**.
4. Run `mf daemon register`, then start the daemon.

Existing `~/.manyfold/workspaces` and `~/.manyfold/skills` data remains in
place.

## See also

- [Install the CLI](/docs/install/)
- [Register a self-owned computer](/docs/local-daemons/)
- [CLI command reference](/docs/cli/reference/)
