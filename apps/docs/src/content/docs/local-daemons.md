---
title: Register a self-owned computer
description: Connect your own laptop, desktop, or homelab as a Manyfold runtime.
order: 4
---

# Register a self-owned computer

A self-owned computer lets Manyfold route work to a machine you control instead of a cloud sandbox. The `mf` CLI runs a local daemon in the background on that machine, advertises which coding agents are installed (Claude Code, Codex, Gemini CLI), and handles agent sessions on demand.

Use a self-owned computer when you need:

- Direct access to local repositories or filesystem.
- CLI tooling already installed on the machine.
- Your own GPU, network, or compute environment.

## Before you start

- Install the `mf` CLI on the machine you want to register. See [Install the CLI](../install/).
- Choose the [CLI profile](../profiles/) that should own this registration.
- Sign in: `mf login`. On a headless machine you reach over SSH, use `mf login --no-launch-browser` and approve from a browser on any other machine.

The shortest path is `mf setup`, which signs in, issues a machine token,
registers the host, installs autostart, and waits for the daemon to become
healthy. Use `mf setup --no-launch-browser` over SSH. The manual token flow
below is useful when an administrator issues the registration token for you.

## 1. Issue a token

Open **Settings → Self-owned computers** in the web app. Under **Register a new machine**, give the machine a name (for example `laptop` or `homelab-1`) and click **Issue token**.

The page shows a ready-to-paste command:

```sh
mf daemon register --token ldt_xxxxxxxxxxxxxxxxxxxxxxxxxx
```

The token is shown only once. Copy the full command immediately. If you lose it, revoke the token and issue a new one.

## 2. Run the command on the target machine

Paste the command into a terminal on the machine you are registering. The CLI:

1. Generates a stable daemon UUID at `~/.manyfold/profiles/<profile>/daemon/daemon.id`.
2. Detects installed coding frameworks (Claude Code, Codex, Gemini CLI).
3. Registers the machine with the API.
4. Saves daemon config to `~/.manyfold/profiles/<profile>/daemon/config.json`.

The registration belongs to the selected profile. Run `mf profile show` to
see the active profile and exact paths.

The output looks like:

```text
✓ daemon registered
  daemonId: dmh_…
  apiUrl:   https://api.manyfold.ai/api
  detected: claude-code 1.2.3
Start the daemon now? It will auto-start on login. [Y/n]
```

Press `Enter` (or `y`) to start the daemon. `mf daemon start` installs an autostart unit (macOS launchd LaunchAgent / Linux systemd user unit) so the daemon comes back automatically every time you log in and is restarted by the OS if it crashes — you don't need to keep a terminal open.

For headless or scripted setups, pass `-y` to skip the prompt and start the daemon in one step:

```sh
mf daemon register --token ldt_xxxxxxxx -y
```

## 3. Verify the machine is online

Go back to **Settings → Self-owned computers** in the web app. The machine appears under **Connected machines** with a green dot. The dot turns gray if the daemon has not sent a heartbeat in the last 45 seconds.

Each connected machine also shows the **CLI version** it's running and how it was started — for example `cli 0.7.0 · autostart · login (launchd)` for a Mac that started via the LaunchAgent, or `cli 0.7.0 · manual` if the daemon was launched directly from a terminal without autostart.

You can also check from the same machine:

```sh
mf daemon status
mf daemon logs
```

## 4. Create an agent on the machine

From the **Connected machines** list, click **+ Create agent →** next to an online machine. The new-agent flow opens with the daemon preselected as the runtime.

You can also open **New agent**, pick a framework, and choose **Self-owned computer** as the runtime.

## Manage the daemon

```sh
mf daemon status              # process + heartbeat state, plus autostart status
mf daemon logs                # tail the local log file
mf daemon start               # install autostart unit and start (default: login scope)
mf daemon stop                # stop the daemon and remove its autostart unit
mf daemon doctor              # diagnose registration / framework detection issues
```

The daemon log lives at
`~/.manyfold/profiles/<profile>/daemon/daemon.log`. `mf daemon logs` resolves
the path for the selected profile automatically.

On macOS and Linux the web terminal gets a full interactive terminal (resize and job control included). On Windows it runs in a limited mode without resize or job control. If `mf daemon doctor` reports `terminal limited` on macOS or Linux, run `mf update` and restart the daemon.

`mf daemon start` and `mf daemon stop` both accept scope selectors:

- `--system` — install at the system scope so the daemon starts at **boot** (no login required). Requires `sudo` because the unit goes into `/Library/LaunchDaemons` (macOS) or `/etc/systemd/system` (Linux).
- `--user` — install or remove the per-login user unit explicitly.

`mf daemon start` additionally accepts `--foreground`. It runs the daemon
inline without touching an autostart unit. The process exits when you close
the terminal; use it for debugging, Windows, or environments without launchd
or systemd such as WSL1 and minimal containers. Automatic daemon installation
is supported on macOS and Linux; Windows requires a foreground process or your
own service manager.

After updating the CLI with `mf update`, run `mf daemon stop` then `mf daemon start` so the autostart unit is rewritten with the new binary path. Launchd / systemd otherwise keeps using the previous path until you restart the unit explicitly.

### Autostart scope

The default `mf daemon start` registers the daemon at **user scope**:

| OS    | Path                                                        | When it starts |
| ----- | ----------------------------------------------------------- | -------------- |
| macOS | `~/Library/LaunchAgents/ai.manyfold.daemon.<profile>.plist` | On login       |
| Linux | `~/.config/systemd/user/mf-daemon-<profile>.service`        | On login       |

`mf daemon start --system` installs at **system scope** and starts the daemon at boot, before any user logs in:

| OS    | Path                                                        | When it starts |
| ----- | ----------------------------------------------------------- | -------------- |
| macOS | `/Library/LaunchDaemons/ai.manyfold.daemon.<profile>.plist` | At boot        |
| Linux | `/etc/systemd/system/mf-daemon-<profile>.service`           | At boot        |

Because unit names include the profile, production and staging daemons can
coexist on one machine:

```sh
mf --profile default daemon status
mf --profile staging daemon status
```

The OS only restarts the daemon when it crashes (non-zero exit). A clean `mf daemon stop` leaves it stopped. If you want the daemon to come back automatically after a `stop`, run `mf daemon start` again.

On Linux user scope, the daemon starts when you log in. To run it at boot without an active login, enable lingering for your user once: `loginctl enable-linger $USER`.

### Workspace and skill storage

Profiles isolate the daemon control plane, not agent data. By default every
profile shares:

```text
~/.manyfold/workspaces
~/.manyfold/skills
```

To give a host isolated roots, declare them when registering:

```sh
mf daemon register --token - \
  --workspace-root /srv/manyfold/workspaces \
  --skills-dir /srv/manyfold/skills
```

The declared roots belong to that host registration and are reported to
Manyfold; changing profiles alone does not move existing agent data.

### Automatic updates

An init-managed standalone daemon connected to the official API checks its
release channel every six hours and updates only while idle. Busy daemons retry
later rather than interrupting sessions. Set `MF_DAEMON_AUTO_UPDATE=0` in the
daemon environment to disable this, or `1` to force it for a custom deployment.
Manual `mf update` still requires restarting the daemon so the init unit loads
the new binary.

## Troubleshooting

- **`daemon register requires --token <token>`** — the command was run without a token. Re-copy the full command from the web UI.
- **`token must start with ldt_`** — the token was truncated during copy. Re-copy it.
- **Machine stays offline** — confirm the daemon process is alive (`mf daemon status`) and that outbound HTTPS to `api.manyfold.ai` is reachable from the machine.
- **Token already bound** — each token can register exactly one machine. Issue a new token for additional machines.
- **Revoking a machine** — open **Settings → Self-owned computers** and click **Revoke**. Agents bound to that machine are marked stopped; workspace files on the machine itself are kept.
- **`systemd not available`** on Linux — your environment doesn't have a usable user systemd session (common in WSL1 and minimal containers). Run `mf daemon start --foreground` in a long-lived shell, or use `--system` (requires sudo and a system-level systemd).
- **Daemon shows `manual` in Connected machines** — the daemon was started without `mf daemon start` (for example via `--foreground` or by an old version of the CLI). Run `mf daemon stop && mf daemon start` to register an autostart unit.
- **Connected machines shows an old CLI version after `mf update`** — the OS is still running the previously-loaded binary. Run `mf daemon stop && mf daemon start` to relaunch under the new binary.
- **Upgraded from CLI 0.21 or earlier and the machine is unregistered** — CLI 0.22 removed the pre-profile config and daemon fallbacks. Run `mf login`, issue a fresh machine token, and run `mf daemon register` again in the intended profile. Existing agent workspaces under `~/.manyfold/workspaces` are not deleted.
