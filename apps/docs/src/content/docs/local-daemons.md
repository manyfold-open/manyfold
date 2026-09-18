---
title: Register a self-owned computer
description: Connect your own laptop, desktop, or homelab as a Manyfold runtime.
order: 4
---
A self-owned computer lets Manyfold route work to a machine you control instead of a cloud sandbox. The `mf` CLI runs a local daemon in the background on that machine, advertises which coding agents are installed (Claude Code, Codex, Gemini CLI), and handles agent sessions on demand.

Use a self-owned computer when you need:

- Direct access to local repositories or filesystem.
- CLI tooling already installed on the machine.
- Your own GPU, network, or compute environment.

## Before you start

- Install the `mf` CLI on the machine you want to register. See [Install the CLI](/docs/install/).
- Choose the [CLI profile](/docs/profiles/) that should own this registration.
- Sign in: `mf login`. On a headless machine you reach over SSH, use `mf login --no-launch-browser` and approve from a browser on any other machine.

The shortest path is `mf setup`, which signs in, issues a machine token,
registers the host, installs autostart, and waits for the daemon to become
healthy. Use `mf setup --no-launch-browser` over SSH. The manual token flow
below is useful when an administrator issues the registration token for you.

## Step 1: Issue a token

Open **Settings → Self-owned computers** in the web app. Under **Register a new machine**, give the machine a name (for example `laptop` or `homelab-1`) and click **Issue token**.

The page shows a ready-to-paste command:

```sh
mf daemon register --token ldt_xxxxxxxxxxxxxxxxxxxxxxxxxx
```

The token is shown only once. Copy the full command immediately. If you lose it, revoke the token and issue a new one.

## Step 2: Run the command on the target machine

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

## Step 3: Verify the machine is online

Go back to **Settings → Self-owned computers** in the web app. The machine appears under **Connected machines** with a green dot. The dot turns gray if the daemon has not sent a heartbeat in the last 45 seconds.

Each connected machine also shows the **CLI version** it's running and how it was started — for example `cli 0.7.0 · autostart · login (launchd)` for a Mac that started via the LaunchAgent, or `cli 0.7.0 · manual` if the daemon was launched directly from a terminal without autostart.

You can also check from the same machine:

```sh
mf daemon status
mf daemon logs
```

## Step 4: Create an agent on the machine

From the **Connected machines** list, click **+ Create agent →** next to an online machine. The new-agent flow opens with the daemon preselected as the runtime.

You can also open **New agent**, pick a framework, and choose **Self-owned computer** as the runtime.

## Saved MCP and platform context

For Claude Code, Codex and Gemini CLI agents, Manyfold retries saved MCP
configuration and platform context after the daemon reconnects. Changes saved
while the computer is offline stay pending until delivery succeeds. Context
also refreshes when linked accounts change, even when its template version
stays the same.

Automatic delivery requires a current CLI. An older daemon shows an upgrade
message; update and restart it, or use the explicit push in agent settings.
Failed writes remain visible and can be retried. Manyfold preserves custom
instructions outside its managed reference block.

## Manage the daemon

```sh
mf daemon status              # process + heartbeat state, plus autostart status
mf daemon logs                # tail the local log file
mf daemon start               # install autostart unit and start (default: login scope)
mf daemon stop                # stop the daemon (and the execs it owns), remove its autostart unit
mf daemon stop --keep-execs   # stop the daemon but leave running execs for the next one to adopt
mf daemon doctor              # diagnose registration / framework detection issues
mf daemon hooks status        # claude / codex session hooks (see below)
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

### Session hooks

When you open a conversation's terminal from the web (the TUI resume), Manyfold needs to know which conversation the `claude` or `codex` process in that terminal is on: whether it renamed the session, cleared it, or started a new one. The CLIs' own `SessionStart` / `SessionEnd` hooks carry that, so `mf daemon register` asks once whether to install them (or `-y` says yes, `--no-hooks` says no). They are written as one script plus one entry per event in `~/.claude/settings.json` and `~/.codex/hooks.json`, marked as Manyfold's, next to any hooks you already have.

The hooks act only inside a terminal Manyfold opened (the shell carries `MF_TERMINAL_ID`) and never print anything, so your own shells and the model's context are untouched. Codex runs a newly installed hook only after you approve it once with `/hooks` in its TUI.

```sh
mf daemon hooks install       # install for the frameworks on this machine, keep current on daemon start
mf daemon hooks status        # what is installed, per framework
mf daemon hooks uninstall     # remove only what Manyfold added
```

Without the hooks the terminal still works: a conversation opened from the web is handed back when you close the terminal or click **Back to web**; only what happens inside the TUI (a `/clear`, a new session) is not tracked.

### One daemon per profile

Each profile admits one daemon process. An overlapping foreground start exits
before connecting or sending heartbeats. A live control socket also blocks a
second start, even if the PID file is missing. A stopped or crashed process's
ownership is recovered on the next start; a live process retains it while the
computer is asleep.

If an older CLI already has multiple copies running, let active work finish
and close the foreground processes you started for that profile. Then stop,
update and restart the selected profile:

```sh
mf --profile default daemon stop
mf update
mf --profile default daemon start
mf --profile default daemon status
```

Keep the same profile and registration. Do not remove PID, socket or ownership
files to bypass an already-running error. Check `mf daemon status` and the
profile's logs first. Separate profiles can still run separate daemons.

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

### Preview: execs that survive a daemon restart

By default a chat turn's process is a child of the daemon, so a daemon restart
(a crash, or an update) ends it. On macOS and Linux, `MF_DAEMON_EXEC_FILES=1`
in the daemon environment starts plain execs detached instead, with their
input and output in files under the daemon's exec directory: a restarted
daemon picks the running process back up and the turn continues. The switch
is off by default while it is verified per framework; `mf daemon start` logs
whether it is on. An exec that runs under a runtime auth profile keeps its
profile lease across the restart too: the new daemon takes the lease over
before it reconnects, so nothing else can run on that profile in between.

Whether an exec actually outlives a restart depends on what supervises the
daemon: launchd always leaves it alone; a systemd **user** unit written by
`mf daemon start` now carries `KillMode=process` for the same effect (reinstall
an older unit with `mf daemon stop && mf daemon start`); a system unit is the
operator's, and `mf daemon doctor` reports what it does. `mf daemon start` logs
`exec survival: yes|no`, and an update only waits for the sessions that would
die with the daemon. A plain `mf daemon stop` ends the execs the daemon owns;
`--keep-execs` leaves them for the next daemon to adopt.

### Terminals stay open on the daemon

A terminal you open on a daemon agent from the workbench belongs to the daemon,
not to the browser tab showing it. If the tab loses its connection (a network
blip, a platform deploy) or you close it, the shell and whatever runs in it —
a resumed `claude` or `codex` session included — keep running on the machine.
The next time the workbench opens that terminal it attaches to the same shell:
the screen comes back as it was, then live output continues. Opening the
terminal for a session that is already held by such a shell attaches to it
too, and takes it over from any other tab that was showing it (that tab says
so and offers to reconnect).

A terminal nobody is attached to is closed after 30 minutes, or after 5
minutes when it runs under a runtime auth profile, since it holds that
profile's lock the whole time. "Back to web" in the chat view ends it right
away. `mf daemon status` shows how many terminals the daemon keeps and how
many have a viewer; a daemon keeps at most 8. A daemon restart still ends
its terminals.

## Troubleshooting

- **`daemon register requires --token <token>`** — the command was run without a token. Re-copy the full command from the web UI.
- **`token must start with ldt_`** — the token was truncated during copy. Re-copy it.
- **Machine stays offline** — confirm the daemon process is alive (`mf daemon status`) and that outbound HTTPS to `api.manyfold.ai` is reachable from the machine.
- **Token already bound** — each token can register exactly one machine. Issue a new token for additional machines.
- **Revoking a machine** — open **Settings → Self-owned computers** and click **Revoke**. Agents bound to that machine are marked stopped; workspace files on the machine itself are kept.
- **`systemd not available`** on Linux — your environment doesn't have a usable user systemd session (common in WSL1 and minimal containers). Run `mf daemon start --foreground` in a long-lived shell, or use `--system` (requires sudo and a system-level systemd).
- **Daemon shows `manual` in Connected machines** — the daemon was started without `mf daemon start` (for example via `--foreground` or by an old version of the CLI). Run `mf daemon stop && mf daemon start` to register an autostart unit. A standalone `manual` daemon can still be upgraded from the dashboard: it swaps its own binary, starts a successor and hands its running execs over, and puts the previous binary back if the successor does not come up (that version is then not retried until another one is chosen).
- **Connected machines shows an old CLI version after `mf update`** — the OS is still running the previously-loaded binary. Run `mf daemon stop && mf daemon start` to relaunch under the new binary.
- **Upgraded from CLI 0.21 or earlier and the machine is unregistered** — CLI 0.22 removed the pre-profile config and daemon fallbacks. Run `mf login`, issue a fresh machine token, and run `mf daemon register` again in the intended profile. Existing agent workspaces under `~/.manyfold/workspaces` are not deleted.
