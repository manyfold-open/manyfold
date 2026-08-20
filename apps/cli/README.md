# mf

Manyfold CLI. Manage agents and runtimes from the terminal.

## Install

```sh
curl -fsSL https://cdn1.manyfold.ai/cli/install.sh | sh -s -- setup
```

To install without running the guided machine setup, omit `-s -- setup`.
The installer skips the archive download when the target path already contains
the selected version.

Or download manually from `https://cdn1.manyfold.ai/cli/v<version>/`:

| platform            | asset                          |
| ------------------- | ------------------------------ |
| linux-x64           | `mf-<ver>-linux-x64.tar.gz`    |
| linux-arm64         | `mf-<ver>-linux-arm64.tar.gz`  |
| macos-x64 (Intel)   | `mf-<ver>-darwin-x64.tar.gz`   |
| macos-arm64 (Apple) | `mf-<ver>-darwin-arm64.tar.gz` |
| windows-x64         | `mf-<ver>-windows-x64.zip`     |

Latest version is at `https://cdn1.manyfold.ai/cli/latest/version.txt`.

Every installed standalone binary supports `mf update` on macOS, Linux, and
Windows. Archive extraction is built in, so the update does not require a
system `tar` or `unzip` command.

> Standalone binaries ship a built-in pty backend (Bun.Terminal) on macOS and Linux, so `mf daemon` web terminals get full resize and job control. Windows builds fall back to a limited pipe terminal. When running from source under Node, the daemon uses `node-pty` instead. `mf daemon doctor` shows the active terminal backend.

## Usage

```sh
mf setup                      # one command: sign in, register this machine, start the daemon
mf --help                     # grouped commands, examples, and environment
mf login                      # browser-based auth
mf login --no-launch-browser  # print URL and paste auth code
mf whoami
mf agent list
mf agent get <agent-id>
mf runtime list
mf daemon status              # local rpc daemon
```

Set the API endpoint and token via flags or env:

```sh
export MF_API_URL=https://your-api.example.com/api
export MF_TOKEN=...
export MF_HTTP_TIMEOUT=30s # ordinary API requests; plain numbers are seconds
export MF_DAEMON_AUTO_UPDATE=0 # daemon self-updates when idle by default (official API URL only)
# or per-call without putting the token in argv:
printf '%s' "$MF_TOKEN" | mf --api-url ... --token - whoami
```

## Dev channel

The `dev` channel carries pre-release builds. It only exists in binaries whose
release workflow baked the dev-channel endpoints in at build time
(`MF_CLI_STAGING_API_URL` / `MF_CLI_STAGING_CDN_BASE` — the endpoints are a
property of whoever operates the deployment, not of this repository); a build
made without them reports that no dev channel is available. Dev versions are
shaped like `0.11.1-staging.<stamp>.<sha>`.

A dev binary defaults to its baked pre-release API URL. By default
`mf update` follows its own channel's `latest/version.txt`, but you can switch
channels explicitly — the choice is remembered for later updates:

```sh
mf update --channel dev     # switch to the dev channel and remember it
mf update --channel stable  # switch back to the production channel
mf update --check           # preview against the remembered channel
```

`dev` and `stable` are the channel names; `dev` is the pre-release channel
(`--channel staging` still works as an alias; the `MF_CHANNEL` env var is read
by `install.sh` only, not by the installed binary). The preference is stored in
`~/.manyfold/update-channel.json` at the machine level — the update channel is
a property of the binary, not of any profile — so it survives the
cross-channel binary swap; delete it to fall back to the binary's built-in
channel.

## Profiles

A profile is the local projection of one environment (ADR-0014), and it holds
the control plane only — credentials, pending logins, daemon registration and
state:

```text
~/.manyfold/
├── profiles/<name>/
│   ├── config.json      # apiUrl (pinned at login) + token
│   ├── pending-login.json
│   └── daemon/          # registration, pid, logs, exec buffers, socket
├── workspaces/          # agent workspaces — machine-scoped, shared by all
└── skills/              # host skill store — same
```

The data plane (`~/.manyfold/workspaces`, `~/.manyfold/skills`) is shared by
every profile and addressed by globally-unique agent id — a workspace belongs
to an agent, not to a profile. A host that wants isolated roots declares them
at registration (`mf daemon register --workspace-root … --skills-dir …`);
that is the opt-in mechanism, not the default.

Select a profile with `--profile <name>` or `MF_PROFILE=<name>`; without
either, a stable binary uses `default` and a dev binary uses `staging`, so a
dev build never touches production credentials by accident. Names must match
`[a-z0-9][a-z0-9_-]{0,31}`. `default` is a name like any other — it has no
special paths. Init units are per profile too
(`ai.manyfold.daemon.<name>` / `mf-daemon-<name>.service`), so daemons for
different environments coexist on one machine.

```sh
mf profile show             # current profile, source, paths, login + daemon state
mf profile list             # every profile on this machine
mf profile delete <name>    # credentials + daemon state + init units;
                            # agent data (shared data plane) is never touched
```

The profile is bound to the environment it logged into: `mf login` stores the
apiUrl next to the token, and the daemon serves its registration's apiUrl no
matter which channel the binary follows (a cross-channel binary only logs a
warning). What profiles do NOT isolate: agent workspaces and the skill store
(shared data plane, above), the `mf` binary itself (one install path, one
channel at a time) and framework homes like `~/.claude` / `~/.codex`, which
the frameworks themselves keep machine-global.

## Docs

https://github.com/protagolabs/manyfold

## Releasing

The CLI is distributed as standalone binaries on `cdn1.manyfold.ai` (Cloudflare R2). Versioning is managed with [Changesets](https://github.com/changesets/changesets).

1. In any PR that changes user-facing behavior, run `pnpm changeset` and commit the resulting `.changeset/*.md`.
2. Merge to `main`. The `changeset-version-pr` workflow opens (or updates) a "Version Packages" PR that bumps `apps/cli/package.json` and writes `apps/cli/CHANGELOG.md`.
3. Merge that Version PR.
4. Run `just cli-release` locally — tags `cli-v$VERSION` and pushes. The `release-cli` workflow then builds 5-platform binaries and uploads them to `https://cdn1.manyfold.ai/cli/v$VERSION/` plus refreshes `cli/latest/version.txt` and `cli/install.sh`.

See `.changeset/README.md` for bump-level rules (patch/minor/major).

## License

MIT
