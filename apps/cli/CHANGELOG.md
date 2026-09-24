# @manyfold/cli

## 4.4.0

### Minor Changes

- [#341](https://github.com/manyfold-open/manyfold/pull/341) [`eb5eb47`](https://github.com/manyfold-open/manyfold/commit/eb5eb473ec0fc8cd86484a49220ff6e657eb6b7b) Thanks [@yingca1](https://github.com/yingca1)! - Add Pi (pi.dev) as a coding agent framework. Pi agents run on the stateful
  sandbox, Kubernetes and self-owned computer (daemon) runtimes and, like the
  other coding CLIs, take their model either from a platform provider — a saved
  or managed provider of the Anthropic, OpenAI or Google protocol, or a vendor
  API key — or from Pi's own sign-in on the runtime: the machine's own `pi`
  configuration, or a runtime account added from the create flow or the runtime
  page (run `pi` and use `/login` for a Claude Pro/Max, ChatGPT Plus/Pro or
  Copilot subscription, or an API key). Sessions resume with `pi --session-id`
  in chat and in the terminal, whose new messages sync back to the chat, and
  `mf daemon hooks install` adds Pi's session hook, an extension Pi loads on its
  own: leaving the TUI hands the conversation back, and a session started in the
  terminal joins the chat list when the terminal closes. A Pi turn cut off by an
  API restart finishes under its own message, read back from Pi's session file
  when the runner's stream cannot be picked up again. A Pi conversation can also
  be handed to herdr, like Claude Code and Codex. On sandboxes and Kubernetes,
  Pi's find and grep tools work out of the box: fd and ripgrep come with Pi
  there. The composer switches between the provider's models and the ones
  `pi --list-models` offers locally, the credentials dialog can move an agent to
  another vendor's provider, the four-step create flow lists Pi, and
  `mf agent create --framework pi` takes `--pi-api-key` with `--pi-provider`. A
  platform provider is what every turn uses on any runtime, gateways included:
  Pi's own sign-in or `models.json` on a machine never takes its place, while
  Pi's settings, skills and sessions still apply. Pi's own sign-in on a runtime
  needs the Manyfold CLI from this release there.

## 4.3.0

### Minor Changes

- [#504](https://github.com/manyfold-open/manyfold/pull/504) [`be6917f`](https://github.com/manyfold-open/manyfold/commit/be6917f8c354b65f2aef8def171e295d117cfc90) Thanks [@yingca1](https://github.com/yingca1)! - New `mf doctor`: one command that finds what is wrong with this machine's mf setup and says how to fix each problem. It checks the install (update available, which `mf` your PATH resolves to, `--api-url`/`--token`/`MF_*` overrides in this shell), then every profile on the machine: its sign-in and API (unreachable, not a Manyfold API — with the `/api` URL it should have been — database down, redirected to a sign-in page, rejected token and why), and its daemon (registration, process, autostart unit, a daemon still running an older binary than the one on disk, why it is offline from the last WebSocket close, coding agents on your PATH the daemon did not detect). Only `--profile` narrows it to one profile. It exits 1 when a check fails, with the report on stdout either way; `--json` gives the same report for scripts. A profile nobody uses (not current, no daemon, no autostart unit) can only warn. It writes nothing locally and never prints a token. The docs now give `dev` as the default profile of dev binaries.

### Patch Changes

- [#504](https://github.com/manyfold-open/manyfold/pull/504) [`be6917f`](https://github.com/manyfold-open/manyfold/commit/be6917f8c354b65f2aef8def171e295d117cfc90) Thanks [@yingca1](https://github.com/yingca1)! - The daemon no longer redials about once a second when the API turns its registration away. The API accepts the WebSocket upgrade and only then refuses a revoked, deleted, unbound or too-old daemon, and the reconnect backoff reset on every upgrade; it now resets only once the server takes the hello, and a refusal (close 4401, 4403, 4404, 4406 or 4409) is logged with its fix and retried slowly, from one minute up to one attempt every 15 minutes, so a machine registered again still comes back on its own. A rejected heartbeat is now logged with its status and error message (when the problem starts, changes and clears, not every 15 s) instead of being ignored, and a heartbeat times out after 15 s instead of piling up. `mf daemon start` passes `MF_CONFIG_DIR` into the autostart unit, so a daemon on a custom config dir no longer starts on the default one and exits forever. An invalid `MF_HTTP_TIMEOUT` stops the command with an error instead of silently using 30 s. `mf daemon status` no longer puts the API's raw response body into `apiError`; it reports the status and the error message. It also validates the registration the way `mf daemon start` does, and fails with the same error on one that start refuses, instead of showing it as configured.

## 4.2.0

### Minor Changes

- [#495](https://github.com/manyfold-open/manyfold/pull/495) [`ffb7124`](https://github.com/manyfold-open/manyfold/commit/ffb7124d82bb231fea4b6ae36d3a46bbbaae2ee0) Thanks [@yingca1](https://github.com/yingca1)! - Hand a chat session to herdr. When an agent's runtime has herdr installed — your own computer running the daemon, or a sandbox — the chat header's "Switch to TUI" becomes "Switch to herdr": the conversation's Claude Code or Codex TUI opens in a herdr pane (a workspace per agent, a tab named after the conversation), and the web's terminal view shows that herdr with the pane focused. Views follow the conversation on their own: a session held by herdr shows herdr, quitting the TUI there brings the chat back with what was said imported, and "Switch to Chat UI" takes the conversation back. The banner's Show in herdr / Continue in web / Back to web buttons are gone; the header switch is the only control. Sandboxes get herdr installed when their runner is set up, and the Update Center lists herdr next to the mf CLI for every machine and sandbox, with upgrade (and install) actions; the runtime detail page shows the herdr version. `mf daemon status` and `mf daemon doctor` report herdr availability and version.

### Patch Changes

- [#496](https://github.com/manyfold-open/manyfold/pull/496) [`52dec83`](https://github.com/manyfold-open/manyfold/commit/52dec83dcc14479da0eff2957ff9d37b4bb43fd4) Thanks [@yingca1](https://github.com/yingca1)! - herdr handoff follow-ups. Handing a sandbox conversation to herdr now honours the sandbox's terminal opt-in, like the browser terminal: the web asks to enable the terminal first, and the API refuses a sandbox whose terminal is off before waking its runner. A Claude Code handoff on a sandbox without model credentials in the terminal says which setting to turn on. Sandboxes that get herdr from the platform skip herdr's first-run welcome. In the web, right-clicks inside the embedded herdr go to herdr's own menu instead of the browser's; a conversation left in herdr comes back in herdr when you return to it or reload, and moving between conversations herdr holds keeps the same view and only moves herdr's focus; the notes that sat above the composer about herdr and the Chat UI move behind a "?" after the header's view switch (a stuck import keeps its banner, with retry and abandon). The daemon no longer raises a herdr notification each time the web moves focus. Handing the same conversation to herdr again takes over its existing tab instead of adding another, and a daemon that restarts (an upgrade, a sandbox runner brought back after a suspension) adopts the herdr panes it opened, so their conversations stay handed off and their tabs still close.

## 4.1.0

### Minor Changes

- [#476](https://github.com/manyfold-open/manyfold/pull/476) [`ad9b1e5`](https://github.com/manyfold-open/manyfold/commit/ad9b1e5f14ec0bf45d20fda2d29b2be3ec6e7300) Thanks [@yingca1](https://github.com/yingca1)! - File-based execs (`MF_DAEMON_EXEC_FILES=1`, ADR-0029 §4) now cover execs that run under a runtime auth profile and execs with temporary settings. The profile lease travels with the exec as a path in its meta (never the composed env): a daemon that adopts the exec after a restart re-stamps the lease with itself before it reconnects, and stops the exec instead if the lease is already gone or held by another live process; the temporary-settings directory is drained and removed at completion whichever daemon gets there. Only an exec that keeps stdin open still uses the pipe path.

- [#473](https://github.com/manyfold-open/manyfold/pull/473) [`035e697`](https://github.com/manyfold-open/manyfold/commit/035e697bb9a1ee84b1296bee029cd95e2abc2ac3) Thanks [@yingca1](https://github.com/yingca1)! - `mf daemon stop` now also ends the execs the daemon owns (by their recorded identity), and `--keep-execs` leaves them for the next daemon to adopt — which is what the platform's runner bring-up passes once a daemon advertises `exec.files.v1`. The systemd user unit `mf daemon start` writes carries `KillMode=process`, so a detached exec outlives the daemon's restart; whether that holds for the actual installation is decided at start (launchd: yes; systemd: only with `KillMode=process`; manual: no), logged as `exec survival`, reported by `mf daemon doctor`, and used by the update drain, which only waits for sessions that would die with the daemon and keeps admitting adoptable execs while an update is pending. `mf daemon status` shows how many running execs would survive a restart.

- [#474](https://github.com/manyfold-open/manyfold/pull/474) [`b8e1f90`](https://github.com/manyfold-open/manyfold/commit/b8e1f90b12273e34809097c04a824a2f7d513e75) Thanks [@yingca1](https://github.com/yingca1)! - A daemon started without an init unit (`manual`: the sprite runner, `mf daemon start --foreground`) can now take a remote upgrade when it is a standalone macOS / Linux binary and not the pod runner (ADR-0029 §5). The old process drives it: the downloaded binary must pass `--version` before it replaces anything (now true for every self-update), the running binary is kept as `<mf>.prev`, the daemon hands its running execs to a successor it starts detached and watches the successor answer on the control socket with the new version; if that never happens it stops the successor, restores `.prev`, relaunches it and refuses that target version until another one is chosen. The daemon advertises `daemon.update.manual` when it can do this, so the dashboard's upgrade works for such daemons and the platform upgrades a capable sprite runner through `daemon.update` instead of installing over it. A restarted daemon also tells the platform once, in its first hello, what it made of the execs it inherited and whether an upgrade was rolled back; both are recorded as audit entries on the daemon.

- [#471](https://github.com/manyfold-open/manyfold/pull/471) [`c4bcb8f`](https://github.com/manyfold-open/manyfold/commit/c4bcb8f3047e8ab494e106ded65c9c1c2a214f20) Thanks [@yingca1](https://github.com/yingca1)! - The daemon can run chat-turn execs without pipes (ADR-0029 §4, first slice, gray release off by default). With `MF_DAEMON_EXEC_FILES=1` on macOS / Linux, a plain exec (no runtime auth profile, no temporary settings, no interactive stdin) starts detached through a fixed `/bin/sh` wrapper: stdin comes from a file, stdout and stderr append to log files in the exec directory, and the wrapper commits the exit code as one line in `exit`. The daemon only tails those files, stamps every event with its source byte offset, and on restart adopts an exec that is still running when its pid, start time and boot id all match what it recorded — never signalling a recycled pid — or completes one whose exit line landed while nobody watched. Aborts and deadlines are persisted before they take effect (a timeout reports exit code 124, a signal death 128+n, a kill hits the whole process group), `exec.start` is idempotent by ref id, and the raw logs are deleted at completion. Windows keeps the pipe supervisor; every other exec keeps the pipe path until the next slices move it. `mf daemon start` logs whether the switch is on.

- [#470](https://github.com/manyfold-open/manyfold/pull/470) [`19a9156`](https://github.com/manyfold-open/manyfold/commit/19a9156d511e7750f9cea2473041f63c1719f404) Thanks [@yingca1](https://github.com/yingca1)! - Terminals now tell the platform which CLI session they are on (ADR-0029 §3, hook reporting).

    - `mf daemon hooks install | uninstall | status`: Manyfold's `SessionStart` / `SessionEnd` hooks for `claude` and `codex`, written as one marked script plus one marked entry per event in `~/.claude/settings.json` and `~/.codex/hooks.json`, next to your own hooks. `mf daemon register` asks once (`-y` says yes, `--no-hooks` says no); the choice is remembered and `mf daemon start` keeps the hooks current. A sprite runner installs them by default. The hooks act only inside a terminal Manyfold opened (`MF_TERMINAL_ID`), never print, and are not installed on Windows.
    - API: `POST /terminal/session-hooks`, reachable only with the token of a live Manyfold terminal. A resume that came back under a new id, or a compaction that changed it, moves the chat session to the new ref after importing the old ref's tail; a TUI that opens an idle chat session takes its hold; one that opens a session with a turn in flight, or held by another terminal, is left alone and the tab is warned; a session that started fresh in the terminal (`startup`, `/clear`, fork) becomes a chat session of its own — marked `origin: terminal` — when the terminal ends, if its transcript is not empty; `SessionEnd` gives the hold back and runs the import without waiting for the terminal to close.
    - Every terminal Manyfold opens now carries the full four-key runtime identity (`MF_API_URL` and `MF_DEPLOY_ENV` were missing on the daemon arm) plus `MF_TERMINAL_ID`, registered as terminal surfaces of the exec env contract.

- [#475](https://github.com/manyfold-open/manyfold/pull/475) [`673428d`](https://github.com/manyfold-open/manyfold/commit/673428d2d6eb25334f6edd22de25d45987e9b26e) Thanks [@yingca1](https://github.com/yingca1)! - Terminals on daemon agents now belong to the daemon rather than to the browser tab showing them (ADR-0029 §6). The daemon keeps the shell and a headless copy of its screen when the tab's connection drops or the tab closes; the workbench's reconnect, or the next open of a terminal for a session that shell holds, attaches to the same shell and gets the screen back, taking it over from any other tab (which is told with close code 4409). A terminal nobody is attached to is closed after 30 minutes, or 5 minutes under a runtime auth profile; "Back to web" ends it at once. The daemon lists the terminals it owns in every hello and heartbeat, and the platform now takes that list, not the tab's tunnel, as proof that a terminal's hold is alive: a terminal the daemon no longer reports has its row ended and its hold released, and a terminal no row claims is closed. `mf daemon status` shows the terminals kept and attached; a daemon keeps at most 8. Daemons without the capability (`pty.terminal.v1`) keep the previous stream-bound behaviour.

### Patch Changes

- [#467](https://github.com/manyfold-open/manyfold/pull/467) [`6567ab2`](https://github.com/manyfold-open/manyfold/commit/6567ab2f2f26bc4241044e103339b21ed40565cf) Thanks [@yingca1](https://github.com/yingca1)! - Automatically retry saved MCP and platform context configuration when a supported daemon reconnects. Serialize manual, on-change and reconnect delivery per computer, keep failed or superseded snapshots stale, and protect configuration files against delayed writes from retired connections or expired delivery attempts. Older daemons keep explicit push support and require a CLI update for automatic delivery.

## 4.0.0

### Major Changes

- [#463](https://github.com/manyfold-open/manyfold/pull/463) [`11ebadb`](https://github.com/manyfold-open/manyfold/commit/11ebadb44f2f97a89fd7d5a92cec1dc863492b30) Thanks [@yingca1](https://github.com/yingca1)! - Replace ambiguous agent `storageBytes`/`storageMeasuredAt` fields with nullable `workspaceBytes`/`workspaceMeasuredAt`. Add scoped cached sandbox storage reports, measurement freshness and conservative path attribution; runtime account reads require explicit account intent and `agents:read` consent.

    `mf sandbox storage-usage` reports the current sandbox, while `--account` reports all account sandboxes. `mf agent list --json` now returns `{ scope, agents }`; agent path diagnostics keep sleeping measurements unknown and expose cached sandbox usage separately. Upgrade the API and CLI together: storage commands and agent list/get reject older ambiguous responses.

## 3.0.3

### Patch Changes

- [#441](https://github.com/manyfold-open/manyfold/pull/441) [`3178178`](https://github.com/manyfold-open/manyfold/commit/3178178023a0a1a2f07da45d43fe56f309d8825d) Thanks [@yingca1](https://github.com/yingca1)! - Own temporary per-exec settings and terminate their isolated process tree before completing cancellation, cleaning resources before the final execution acknowledgment on every supported platform.

## 3.0.2

### Patch Changes

- [#422](https://github.com/manyfold-open/manyfold/pull/422) [`faf8b50`](https://github.com/manyfold-open/manyfold/commit/faf8b50cf4f2f49f2a716e8dcc5917c35513c6b0) Thanks [@yingca1](https://github.com/yingca1)! - Log daemon startup before bounded shell PATH probes, forcibly reap timed-out probe process trees and retain the original PATH fallback. Sign completed Darwin binaries with identifier ai.manyfold.mf and strictly verify signatures, archive contents and updater byte preservation before release upload. Ad-hoc signatures do not guarantee that macOS TCC permissions survive upgrades.

- [#433](https://github.com/manyfold-open/manyfold/pull/433) [`f8c2287`](https://github.com/manyfold-open/manyfold/commit/f8c22872c5032f66a5063213a7b82d8e2987152d) Thanks [@yingca1](https://github.com/yingca1)! - Wait for runtime-auth profile cleanup before completing executions, so immediate same-profile work can acquire the released lock. Report cleanup failures without exposing credentials and retain execution ownership until cleanup finishes.

- [#431](https://github.com/manyfold-open/manyfold/pull/431) [`cbd9d94`](https://github.com/manyfold-open/manyfold/commit/cbd9d946f34be473a4567f6142f6b18e5e960017) Thanks [@yingca1](https://github.com/yingca1)! - Retry temporary Windows file-replacement denial when publishing protected state and daemon ownership metadata. Keep the original target intact, retain the kernel lock during publication, and bound retries so persistent permission errors still fail startup cleanly.

## 3.0.1

### Patch Changes

- [#396](https://github.com/manyfold-open/manyfold/pull/396) [`415f45a`](https://github.com/manyfold-open/manyfold/commit/415f45ab8f2df2367de27c7dcb26b617a36d8fb3) Thanks [@yingca1](https://github.com/yingca1)! - Keep one daemon process per profile, preserve the current owner's PID and control socket during concurrent starts or cleanup, and recover ownership after a crash. Ignore obsolete WebSocket callbacks, keep reconnect attempts single-flight, and preserve new RPC cancellation handlers when older connections finish. Include optional process identity and complete hello records for diagnosing connection churn. Existing duplicate foreground processes should be stopped before updating and restarting the same profile.

## 3.0.0

### Major Changes

- [#366](https://github.com/manyfold-open/manyfold/pull/366) [`196b37d`](https://github.com/manyfold-open/manyfold/commit/196b37dc1b6fb5d19ab38bcbb467c894fd15cbf8) Thanks [@yingca1](https://github.com/yingca1)! - Clients now require the canonical Manyfold API contract. `mf whoami` calls
  `/auth/whoami` only and reports a missing endpoint instead of retrying
  `/auth/me` and constructing a legacy identity response. Login and setup still
  use `/auth/me` for their current account flow.

    The shared SDK recognizes structured errors only inside the `error` object.
    Legacy top-level `code`, `message`, and `details` fields no longer supply error
    metadata. HTTP status fallback and raw-response diagnostics remain available;
    CLI error output never prints an unparsed response body.

    Upgrade self-hosted APIs before deploying these clients. Servers must provide
    `/auth/whoami` and the `{ ok: false, error: { code, message, details? } }`
    response contract. Existing Agent runtime and external A2A identities are
    unchanged.

## 2.0.0

### Major Changes

- [#362](https://github.com/manyfold-open/manyfold/pull/362) [`a72fd5e`](https://github.com/manyfold-open/manyfold/commit/a72fd5e55423bfba77276928f047960c70ced0f2) Thanks [@yingca1](https://github.com/yingca1)! - Use `mf a2a send` to invoke a peer or URL and `mf a2a status` to list callable peers and in-flight tasks. The deprecated `call`, `stream`, and `peers` aliases have been removed. Replace `stream <url> <prompt>` with `send <url> <prompt> --stream`; replace scripts reading the `peers --json` array with `status --json` and read its `peers` field. Update saved scripts and Agent instructions before upgrading the CLI.

    The Web A2A exposure dialog now points to the supported status command in every language.

## 1.1.0

### Minor Changes

- [#354](https://github.com/manyfold-open/manyfold/pull/354) [`aef0bb7`](https://github.com/manyfold-open/manyfold/commit/aef0bb74954b2e95c40cf3e29f4c333fc8ddb4d8) Thanks [@yingca1](https://github.com/yingca1)! - Agent create (v1): the model provider section is built like the runtime section — an All / Cloud / Local chip row over one grid of pick cards (the saved providers and the runtime's accounts side by side, the chips only filtering) and one row of dashed add chips under it. Cloud lists the saved providers and adds new ones through the same built-in / custom forms as Settings → Model Providers, in a dialog that refreshes the list and picks the new row. Local lists the runtime's host sign-in and its added accounts as the runtime page's Account section shows them (same identity, plan and status tags, the same Sign in for a host or account that needs one, a Manage accounts link for the rest), signs a new subscription in from the page, and can now store an API key on the runtime: an `api-key` auth profile keeps the key in its own credential context on the host and injects it as the vendor variable for that profile's runs (needs an `mf` daemon advertising `auth-api-key.v1`; the API refuses the create on older ones). The runtime page's Account section and the create form's Local group now render one shared account list (`RuntimeAccountList`): the same rows, the same Sign in button and account menu, the same dashed "+ Add account" / "+ Add API key" chips and the same sign-in dialog; the create form only adds the pick. The accounts are laid out like the create form's runtime cards, two to a line: each account is headed by who it is signed in as (the host row is simply "Host sign-in" until it is), with plan and organization on one quiet line, its status tag, and Sign in on the row when it needs one; the host's usage sits two windows to a line, and the list ends with Add account. The explanatory copy that repeated what the rows already said is gone. Joining an existing runtime no longer offers a "Same credentials as the runtime" row: for a coding framework the runtime's credentials are the Local list (its host sign-in row is that binding), so a Cloud pick is always an explicit provider; the frameworks without a Local list (openclaw, hermes, external, narranexus) simply inherit, as before, and a subscription choice no longer sends an empty credentials PATCH.

    Sandbox runners come up earlier: a coding-framework agent create registers and starts the sprite's runner while the VM is still awake from the framework install (`starting_runner` step), picking a sandbox runtime in the create form prewarms its runner (debounced, same admission and metering as a click), and a runner woken for an account operation is held awake for a few minutes so the sign-in or key that follows does not wake it again.

    A sandbox delete whose sprites.dev call fails no longer pins the user's active-slot cap: revoked host rows are excluded from every concurrent-active count, and the sandbox reaper now retries the delete for a revoked row a few minutes later instead of leaving it as a permanent ghost. A wake refused by that cap is reported as its own state (`sandbox-limit`) on the runtime page and in the create form's Local list, with a check-again action, and is never cached as a failed probe.

    Account usage is read from the vendor at most once every ten minutes per runtime: the runtime page's opens and refreshes re-read the sign-in but reuse the kept usage, a refused re-read keeps the last good numbers (the card says when they were read), and the host card's menu has Refresh usage for an explicit re-read (`GET …/account?refreshUsage=1`; the daemon's `account.inspect` and the sandbox probe both accept a usage flag).

    The create form (v1) gathers every model setting under one Advanced config section after the provider: the framework's model mapping (folded) with its default model and effort for a platform provider on Claude Code or Codex, the primary model for openclaw / hermes, or the model override for an agent that simply inherits its runtime's credentials. The mapping now applies when joining an existing runtime too: the join sets the agent's model config right after its credentials. Both the Model provider and the Advanced config labels carry the same question-mark help as the framework and runtime labels, opening a short explanation of Cloud vs Local and of what the mapping does.

    Opening the create form for a runtime (`?runtimeId=`) no longer loses that selection to the first sandbox host when the hosts load before the runtimes.

    Each sandbox card in the create form (v1) shows every framework a sandbox can hold as icons — the three coding CLIs and OpenClaw, Hermes and NarraNexus — present ones in colour with a green edge, absent ones greyed behind a dashed edge — and each icon opens a menu with the installed version against the catalog, the agents already running that framework there (each a link to its chat), and the one action that closes the gap: Check (a sandbox never probed), Install, or Upgrade to the latest. A coding CLI on a bare sandbox installs through a new `POST /sandboxes/:id/frameworks/:framework/install` (the same staged npm install as the agent-level upgrade, re-probed and persisted afterwards); a sandbox that already runs the framework upgrades through its primary agent, as the runtime page does. The service frameworks are known through the runtime that runs them and install by a click too: the menu's Install brings the framework up on the sandbox as a runtime with no agent yet (installed and started, its model provider filled in by the first agent's pick), and the menu says when the sandbox's one public port is already taken by another of the three. Deep links into the form (`?sandboxId=`, `?runtimeId=`) no longer lose their target to the first host when the lists load in the other order.

    A bare sandbox that already has the coding CLI takes a subscription account before any agent exists: picking it in the create form (a click, a deep link or a sandbox just created — never the list's own default pick, which offers Add account instead and prepares on the click) brings the framework's runtime up on it right away (`POST /sandboxes/:id/frameworks/:framework/runtime` — an agent-less runtime row, the CLI left at the version found, only a missing one installed at the version agent create would pick; idempotent over a live runtime — the form's own prewarm starts the runner) and re-targets the form at that runtime, so Codex and Gemini CLI on a sandbox show the same Local group as Claude Code — host sign-in, added accounts, Add account / Add API key — instead of a "sign in after creating" row. A sandbox never probed is checked first (its CLI inventory read while it is awake), and one whose CLI turns out to be missing gets an Install chip in the same place — so a sandbox created from the form goes straight to its accounts, or straight to installing the framework, instead of the "sign in after creating" copy. A failed step shows why, with a retry. The agent then joins the runtime the way any later one would, promoted to its primary; the runtime page lists such a runtime with zero agents until then. A credentials change for an agent on a sprites runtime that has no stored credentials yet (one prepared this way) resolves from the request instead of demanding a rebuild.

    The Model provider section has the same shape for every framework now. OpenClaw and Hermes, which speak both vendors' protocols, list the saved providers of both families in one grid under All / Anthropic / OpenAI chips that only filter (the picked card's family is the vendor the primary-model default follows), with the same dashed "Add model provider" chip offering both families' catalog entries; the old Anthropic | OpenAI toggle over a separate list is gone. NarraNexus, which takes no provider from Manyfold, shows one card saying it manages its model provider in its own UI, and creating a NarraNexus agent no longer demands an unrelated saved provider.

    Every runtime card in the create form's Agent runtime section has a menu bottom-right. A sandbox card — bare, or the runtime on it — offers Rename runtime, Rename sandbox and Delete sandbox (once no agent runs there; its agent-less runtimes go with it): the sandbox is the machine the card stands for, so its runtimes are not deleted one by one from here. A cloud computer's card renames its runtime and deletes it once no agent is left; a daemon's runtimes are the daemon's own and only rename.

    While a picked sandbox is still on its way to being usable, the create button says so and stays disabled — Creating the sandbox… (the new-sandbox dialog closes on the click), Checking the sandbox…, Installing <framework>…, Preparing the sandbox…, Starting the sandbox runner… — so the form cannot be submitted around a step that is still running; the runner-starting line the account list used to show is that same progress and is gone from the list.

    The create form keeps waking the picked sandbox's runner until it answers (asking again after every cycle that ends without an answer) instead of handing the user a "start runner" line and button, so those never appear there; the plan's slot-cap notice keeps a Check again. The sandbox cards' status line says what the machine is doing — Active / Warm / Cold for the VM (the runtime list's words), Starting runner… and Runner online for the picked one — instead of a flat Ready.

    Waking a sandbox runner no longer stalls on a stale twin: when two registrations left two runner-host rows for one sprite, the wake picked one arbitrarily and could wait its full two minutes on the row the process was not using; the lookup now takes the row the runner last answered on.

    A sandbox woken for its accounts no longer sits in the plan's active slot for minutes after the user has moved on. The create form's prewarm holds it for a short window it renews while the runtime stays picked and releases when the pick moves or the page closes (`POST /agent-runtimes/:id/auth-profiles/release`); the runtime page releases the hold its Refresh or sign-in placed when it is left; and a wake the slot cap refuses first lets go of the account holds on the user's other sandboxes, so the next attempt is admitted once they suspend — on the Free plan's single slot, switching sandboxes in the form used to wait out a five-minute hold.

    A sandbox wake the plan refuses fails fast in the create form instead of spinning: the prewarm's admission now runs on the request and answers with the refusal (`RuntimeAuthPrewarmView.refused`), so used-up active hours end the wait at once — the card reads Can't wake, the Local group says the hours are used up with an Upgrade plan link where a plan is sold, and Create is not held — while a full concurrent slot keeps the wait going with the button saying it is waiting for another sandbox to fall asleep.

    Every lookup of a sandbox's runner by name now agrees on which row is the runner when a double registration left two: the one it last answered on. Before, the account list could read a sandbox as asleep off the twin nothing ever connected to while the wake reported the runner live — the create form then showed Starting the sandbox runner… indefinitely. The twin rows are dropped when found, once they are old enough not to be a registration still dialling in.

## 1.0.0

### Major Changes

- [#349](https://github.com/manyfold-open/manyfold/pull/349) [`77d8543`](https://github.com/manyfold-open/manyfold/commit/77d85432dbbdb2ee0f6cb60efc624a4a0b686c97) Thanks [@yingca1](https://github.com/yingca1)! - Close retired runtime and configuration compatibility windows. Daemon registration,
  heartbeats and WebSocket connections require CLI 0.34.0 or newer. Coding daemon
  prompts use stdin transport; turn RPCs use split budgets; update channels use stable/dev.
  Missing credential facts no longer establish readiness, and daemon MCP writes
  always use restrictive file permissions.

    Lark message ingress accepts only the current receive_v1 event contract. Retired
    API environment aliases fail startup, Web/Admin stop reading old build aliases,
    and startup no longer adopts A2A timeout or self-host plan settings. Upgrade older
    self-hosted installations through API 4.0.0 and migrate configuration first.

    Normal runtime provisioning, upgrades, skill activation and keep-alive operations
    no longer perform the completed identity, shared-shell, home-clone or fused-task
    migrations. Existing persisted workspace and lease state paths remain valid.
    Every service wake gets an independent report generation; changing a keep-alive
    lease preserves the current service's report fence and files.

## 0.34.0

### Minor Changes

- [#325](https://github.com/manyfold-open/manyfold/pull/325) [`cbfaaea`](https://github.com/manyfold-open/manyfold/commit/cbfaaea141ae3bcacc3a63dc73a112633969ccfe) Thanks [@yingca1](https://github.com/yingca1)! - Send daemon WebSocket credentials in the Authorization header instead of the
  URL. Self-hosted deployments must upgrade to Manyfold v0.5.0 (API 1.1.0) or
  newer before updating the daemon. Daemons advertise `ws.auth-header` so operators can verify the fleet
  before retiring query authentication.

## 0.33.1

### Patch Changes

- [#287](https://github.com/manyfold-open/manyfold/pull/287) [`86b872a`](https://github.com/manyfold-open/manyfold/commit/86b872a4e98422eebec26a01cfb50c96d7759ae2) Thanks [@yingca1](https://github.com/yingca1)! - Daemon connection-success logs no longer include the authentication URL or its
  bearer token. Existing server authentication remains compatible.

## 0.33.0

### Minor Changes

- [#288](https://github.com/manyfold-open/manyfold/pull/288) [`6b4d090`](https://github.com/manyfold-open/manyfold/commit/6b4d090f692764c94d2367b014e153b2c63d2dcd) Thanks [@yingca1](https://github.com/yingca1)! - Retire the Phase 8 user-grant compatibility layer. The API no longer exposes the legacy CLI poll route or bearer-grant endpoint, runtime authorization no longer uses `enforce_agent_binding`, and the web CLI approval screen keeps only browser login. External A2A grants remain supported.

## 0.32.0

### Minor Changes

- [#280](https://github.com/manyfold-open/manyfold/pull/280) [`193dfe4`](https://github.com/manyfold-open/manyfold/commit/193dfe4803346a0dc331a4f9500d9ca9fd160ac2) Thanks [@yingca1](https://github.com/yingca1)! - Runtime auth profiles (P2, execution contract): an agent can be bound to one of its runtime's auth profiles (`PATCH /agents/:id/runtime-auth`, compare-and-set on a binding version; also at create/attach via `runtimeAuthProfileId`), and every execution for that agent — chat turns over the daemon or the sprite runner, the agent terminal, and the model-capability probe — then runs inside that profile's credential context. The daemon (capability `auth-context.v1`) composes the context itself from an opaque `authSelection`: the profile's own credential files, every ambient vendor variable stripped from both the machine environment and the agent's extras, codex's state databases pinned to the native home, and the profile lock held for the process's lifetime so same-profile work runs serially. A host that cannot honour the selection (a bare sandbox without its runner, a pod, or an older mf CLI) refuses the execution rather than answering with the machine's native sign-in. Switching takes effect for the next execution; a turn already running keeps the context it started with.

- [#279](https://github.com/manyfold-open/manyfold/pull/279) [`055590f`](https://github.com/manyfold-open/manyfold/commit/055590fed25f93c2cad88a8527e8d7c55b916a08) Thanks [@yingca1](https://github.com/yingca1)! - Runtime auth profiles (P1, host store and management API): a coding-CLI runtime can now hold several vendor sign-ins, each in its own credential context on the host. The daemon gains `auth.list` / `auth.create` / `auth.inspect` / `auth.logout` / `auth.operation` RPCs and an `authLogin` mode for `pty.open` (capability `auth-profiles.v1`); a profile's view symlinks sessions, history and config back to the native CLI home so switching auth never forks configuration or transcripts. The API adds `/agent-runtimes/:id/auth-profiles` (list, create, inspect, login, logout, remove), `/agent-runtimes/:id/default-auth` and `/runtime-auth-operations/:id`, with profile metadata, operations and the agent binding columns in new tables. Executing a turn under a profile and the web UI follow in later releases; the existing ambient account probe is unchanged.

## 0.31.2

### Patch Changes

- [#252](https://github.com/manyfold-open/manyfold/pull/252) [`4b96e8c`](https://github.com/manyfold-open/manyfold/commit/4b96e8c929670b4a1827701444844b267a4dca32) Thanks [@yingca1](https://github.com/yingca1)! - Migrate legacy sprite runtime identities into encrypted storage before CLI or framework upgrades clean shared shell profiles.

## 0.31.1

### Patch Changes

- [#242](https://github.com/manyfold-open/manyfold/pull/242) [`e9f99df`](https://github.com/manyfold-open/manyfold/commit/e9f99df9c8a424c1cffc89474e596dc66898c87d) Thanks [@yingca1](https://github.com/yingca1)! - Add an iMessage channel provider

    Bind an agent to iMessage and reach it from the Messages app, in one-on-one
    conversations and in group chats. Apple publishes no iMessage API, so the
    channel talks to a BlueBubbles server you run on your own Mac: paste its URL
    and server password, and Register pings it, reads its version and installs the
    inbound webhook itself, so nothing has to be copied back by hand.

    iMessage has no bot identity to @-mention, so group messages are gated on
    literal wake words instead, stripped from the message before the agent sees it.
    Wake words are escaped as literals rather than compiled as user-supplied
    patterns, because parsing runs on the unauthenticated webhook path where a
    hostile regex would be a denial of service against every channel on the
    instance. Allowlists normalize handles, so `+1 (555) 555-0123` and
    `+15555550123` are one person.

    BlueBubbles can neither set custom headers nor sign its payloads, so inbound is
    authenticated with a per-channel secret embedded in the registered webhook URL
    and compared in constant time. That is weaker than every other channel here:
    the URL is a bearer capability, visible in the BlueBubbles webhook list and in
    tunnel logs, and the allowlist is not a second factor. The channel docs say so
    plainly. Outbound calls are re-checked against the private-address guard on
    every request, not only when the URL is saved, because a write-time-only check
    loses to DNS rebinding.

    Replies are flattened to plain text and split one bubble per paragraph, since
    Messages renders no markdown and cannot edit a sent message — so there is no
    streaming preview. Attachments work in both directions. Reactions, typing
    indicators, read receipts and reply threading are detected and reported but not
    implemented: they all require the BlueBubbles Private API helper, which needs
    SIP disabled on the operator's Mac.

## 0.31.0

### Minor Changes

- [#214](https://github.com/manyfold-open/manyfold/pull/214) [`2ad1d15`](https://github.com/manyfold-open/manyfold/commit/2ad1d15137d8452c0468b50f3e8f85381cb93370) Thanks [@yingca1](https://github.com/yingca1)! - Add the openclaw ACP transport for BYOD daemons (ADR-0027, O6), behind `MF_OPENCLAW_ACP`. The daemon now discovers the host's own resident openclaw gateway from its config on the heartbeat — port and reachability only, never the token, and never starting it — and reports it on the openclaw `DetectedFramework`. When the flag is on and the daemon advertises `turn.openclaw.acp`, a daemon openclaw chat turn is driven as `openclaw acp` against that gateway (the daemon is the ACP client, exactly like a hermes turn) instead of spawning `openclaw agent --local --json`: continuity is the gateway session key (`_meta.sessionKey`, never `session/resume`), the ask mode and per-message model pick are pre-patched in-box over the loopback gateway before the bridge starts, the approval card relays through the existing `turn.permission` RPC, and the turn's token usage is read back from the gateway transcript after the prompt (the ACP stream carries none) and billed. The turn is resumable — the daemon buffers the ACP frames, replayed via `exec.resume`. With the flag off, or against a daemon whose CLI predates the capability, the daemon keeps the legacy CLI-spawn path unchanged.

### Patch Changes

- [#215](https://github.com/manyfold-open/manyfold/pull/215) [`1829eb8`](https://github.com/manyfold-open/manyfold/commit/1829eb8914b60fe94bc5f738a23d6711a0031596) Thanks [@yingca1](https://github.com/yingca1)! - Add a Microsoft Teams channel provider

    Bind an agent to a Microsoft Teams bot and reach it from personal chats, group
    chats and team channels. Bring your own Azure Bot: paste its app ID, client
    secret and tenant ID, run Register to activate the channel, then download a
    ready-made Teams app manifest from the channel page and upload it to Teams.

    Inbound activities are authenticated by validating the Bot Framework JWT
    against Microsoft's key set, checking the audience, the issuer, the signed
    service URL and the tenant on the channel. Allowlists are keyed on Entra
    (Azure AD) object IDs, never on user names or email addresses, because those
    can be reassigned.

    Replies stream by editing one message, land in the originating channel thread,
    and support typing indicators and agent-initiated sends. Personal-chat
    attachments are read; files posted in a channel or group chat are not, because
    Teams strips the reference and recovering it needs Microsoft Graph admin
    consent.

## 0.30.3

### Patch Changes

- [#207](https://github.com/manyfold-open/manyfold/pull/207) [`575b309`](https://github.com/manyfold-open/manyfold/commit/575b3094d06e2f1f585324668f89ad8ef9d13c1a) Thanks [@yingca1](https://github.com/yingca1)! - Lift the framework-neutral ACP decoders (event mapping, permission-request decode, session-state decode, model matching, stderr classifiers, auto-approve / reject option pickers) into `@manyfold/shared` so the API-side and daemon-side ACP clients share one copy, and introduce an `AcpDialect` seam (error prefix, log tag, legacy auto-approve id, optional session/prompt `_meta`) so a second framework plugs into the same client. The API ACP client class is now `AcpTurn` (dialect-taking), with `HermesAcpTurn` kept as an alias. Pure internal refactor with no behaviour change: a live turn and a replayed turn decode through exactly one implementation, and hermes keeps its byte-identical error strings and defaults.

## 0.30.2

### Patch Changes

- [#199](https://github.com/manyfold-open/manyfold/pull/199) [`2a51fa7`](https://github.com/manyfold-open/manyfold/commit/2a51fa740de47ca8284503772dc62f7d7a69d1b4) Thanks [@yingca1](https://github.com/yingca1)! - Add a Google Chat channel provider. Connect a Google Chat app to an agent to reach it from direct messages and spaces in Google Workspace: mention gating, one session per thread with replies nested under the message that started them, space and user allowlists with operator rights, inbound file downloads, and native slash commands.

    Google signs inbound requests with a JWT rather than an HMAC, so the channel verifies it against Google's key set in either audience mode the Chat API console offers — the endpoint URL (captured for you by Register) or the Cloud project number.

    Chat allows only one write per second in each space, shared with every other Chat app there, so this provider defaults its reply mode to Final and paces long replies. Live progress is available per channel. Sending files is not supported: uploading to Chat requires user authorization that an app cannot hold.

    `mf channels create --provider` lists the new provider.

## 0.30.1

### Patch Changes

- [#188](https://github.com/manyfold-open/manyfold/pull/188) [`832cd55`](https://github.com/manyfold-open/manyfold/commit/832cd5569a38397c17a2e4602428d4bf89af88e0) Thanks [@yingca1](https://github.com/yingca1)! - Codex agents can now run GPT-6 Astra. It joins the model catalog at the head of the default preference scan (Astra → GPT-5.6 Sol → Terra → Luna → GPT-5.5 → …), matching the priority order Codex 0.153.4 ships, so a provider that serves Astra now defaults new agents to it while providers without it keep resolving as before. The `max` and `ultra` reasoning levels move from unexposed to selectable, gated per model — Astra, Sol and Terra reach `ultra`, Luna stops at `max`, GPT-5.5 and older stay at `xhigh`. GPT-5.3 Codex is deactivated in the catalog: it no longer exists in the upstream Codex model list.

## 0.30.0

### Minor Changes

- [#143](https://github.com/manyfold-open/manyfold/pull/143) [`d33315f`](https://github.com/manyfold-open/manyfold/commit/d33315f21fc026403638529d45e0aec7553ead08) Thanks [@yingca1](https://github.com/yingca1)! - Switching a session to Terminal can now land you straight in the coding CLI's
  own interactive interface, resumed on that same conversation, instead of at a
  bare prompt. The chat view and the TUI become two front ends over one session.
  Works on sandbox and self-hosted (daemon) agents alike; a daemon needs a CLI
  new enough to advertise the `pty.command` capability, and one that is not says
  so rather than opening a plain shell under a UI that promised a resume.

    The command runs as the shell's argv rather than being typed into the pty, so
    there is no guessing whether the prompt is ready yet, and quitting the TUI
    leaves the interactive shell you would otherwise have had. Only the chat
    session id travels from the browser: the API looks up that session's own
    recorded reference and builds the argv, so no caller chooses what runs in the
    sandbox. Claude Code and Codex are supported; Gemini's resume takes a session
    index rather than an id, so it opens a normal shell.

    The resumed TUI opens in full-access mode (`--dangerously-skip-permissions` for
    Claude Code, `--dangerously-bypass-approvals-and-sandbox` for Codex) and forces
    transcript persistence on, so continuing the conversation there stays in sync
    with the chat view rather than prompting for every action or silently
    discarding what you did. The runtime is already the trust boundary — your own
    daemon machine, or an externally-sandboxed sprite.

    Codex needs nothing further — it signs in on the sandbox at creation and its
    credentials are already on disk. Claude Code's are injected per turn and never
    persist, so its TUI has nothing to authenticate with unless you turn on the
    new per-sandbox **Model credentials in the terminal**, which is off by default
    and separate from the existing terminal switch. It is worth reading before
    enabling: anyone who can open that terminal can then read the key, which the
    API otherwise only ever returns masked. A runtime-local agent needs no such
    opt-in, only its CLI sign-in. When resuming is unavailable the terminal still
    opens as a shell and says which of the two things it was missing.

## 0.29.0

### Minor Changes

- [#144](https://github.com/manyfold-open/manyfold/pull/144) [`6ee91e5`](https://github.com/manyfold-open/manyfold/commit/6ee91e5679ad9e22f9f999b0b87663df5586f85a) Thanks [@yingca1](https://github.com/yingca1)! - Show the signed-in account and its usage on the runtime page, and sign in from there.

    The runtime detail page (`/settings/runtimes/<runtimeId>`) gains an Account section for Claude Code, Codex and Gemini CLI runtimes on self-owned machines and sandboxes: the signed-in identity (email, organization, plan), the sign-in status, and the subscription usage windows with their reset countdowns (Claude 5h/7d, Codex primary/secondary, Gemini per-model quota). The host reads the CLI's own credential files and calls the vendor usage endpoint itself; only the response and non-secret identity fields ever leave the machine.

    - CLI daemon: new `account.inspect` RPC, advertised through the `account.inspect` client feature. Runtime pages of daemons on older CLIs show an update prompt instead of a probe failure.
    - API: `GET /agent-runtimes/:id/account` (`?wake=1` to probe a sleeping sandbox, which starts the VM and reserves an active slot), plus a `runtimeId` target on the terminal websocket for a bare host shell.
    - Web: when the runtime is not signed in, "Sign in" opens an inline terminal on the host that starts the CLI's own headless sign-in (`claude auth login --claudeai`, `codex login --device-auth`, `NO_BROWSER=true gemini`); closing it re-checks the account. The chat sign-in card now recommends `claude auth login --claudeai` too.
    - On macOS machines the Claude and Gemini tokens live in the Keychain, which the daemon deliberately does not read, so identity shows but usage does not.

## 0.28.0

### Minor Changes

- [#97](https://github.com/manyfold-open/manyfold/pull/97) [`6510fb7`](https://github.com/manyfold-open/manyfold/commit/6510fb7b1709402ca45062bb37db592d956c6d89) Thanks [@yingca1](https://github.com/yingca1)! - Hermes chats gain interactive permission approval. The composer's permission menu now works for hermes with three modes mirroring hermes's own edit-approval trio — "Ask for approval", "Accept edits", and "Don't ask" (the default, byte-identical to the previous always-YOLO behavior for every caller that sends no mode). In the ask modes the turn drops `HERMES_YOLO_MODE`, aligns the session via ACP `session/set_mode`, and surfaces `session/request_permission` as an interactive card in the transcript instead of auto-approving; the card's request and settlement persist as stream events AND content blocks, so it survives reconnects and history, and a turn that ends without a resolution renders the card inert. Answers are delivered with `POST …/messages/:messageId/permissions/:requestId` and routed like cancel: the in-process coordinator first, the carrying daemon via the new `turn.permission` RPC second, and a durable `chat_permission_answers` row plus pg NOTIFY for a peer-owned interactive turn (the composite PK makes the second answer a 409 — first click wins). An unanswered ask denies after `HERMES_PERMISSION_TIMEOUT_MS` (default 5 min) with the request's own reject option, and pending asks tick the turn's inactivity budget so a human deciding never reads as a hang. Ask modes on a daemon without the new `turn.hermes.permissions` capability are refused with `hermes_daemon_permissions_upgrade_required` — never silently downgraded to YOLO. The daemon publishes a synthetic `_manyfold/permission_resolution` line into the exec buffer before the child's reply, so a replayed stream reproduces the settlement in live order.

- [#98](https://github.com/manyfold-open/manyfold/pull/98) [`5701b2f`](https://github.com/manyfold-open/manyfold/commit/5701b2fa489aefb84350e2eb9ba7162849fc7218) Thanks [@yingca1](https://github.com/yingca1)! - Hermes chats can switch models per message. The composer's model menu now works for hermes agents (options come from the agent's provider-models cache, which the model-config view serves for hermes too, with a filter box once the list grows past a screenful), and the choice is applied via ACP `session/set_model` — hermes persists a session's model in its own state.db, so env vars cannot move a resumed session. Every transport reconciles by diffing against the models state hermes reports on session/new|resume: an untouched session costs no RPC, and picking "Default" re-sends the default's id because a hermes session would otherwise keep the previous pick under a UI that claims otherwise. Daemon-carried turns gate on the new `turn.hermes.options` capability: an explicit switch on an older daemon is refused with `hermes_daemon_options_upgrade_required` (never silently dropped), while the auto-defaulted value skips quietly; a hermes build that predates `session/set_model` fails an explicit switch as `hermes_set_model_unsupported`. The daemon reports the session's models/modes state on the turn final, captured best-effort into `agents.extras.hermesAcp` for diagnostics.

### Patch Changes

- [#95](https://github.com/manyfold-open/manyfold/pull/95) [`bec1b35`](https://github.com/manyfold-open/manyfold/commit/bec1b356edf0467c51632946050a1a8858245a6b) Thanks [@yingca1](https://github.com/yingca1)! - Hermes chat turns now show tool outputs and stop silently denying file edits. The ACP decoder maps terminal `tool_call_update` frames to `tool_result` events (in their own `hermes-acp-x-<n>` ordinal namespace, so a cross-deploy resume cannot re-key rows the old decoder already wrote), and both ACP clients answer `session/request_permission` with an option the request actually offers — the previous hardcoded `approve_for_session` matches no option id current hermes builds advertise, and an unknown id maps to deny on both of hermes's approval bridges, which rejected every file edit on up-to-date hermes images. Billing now also decodes the `cachedReadTokens`/`cachedWriteTokens` spellings the acp 0.9.0 prompt ack uses, so cache tokens stop falling out of usage records. Hermes's streamed `usage_update` ({used} of {size} context-window pressure — not billing) is no longer discarded: the turn's final reading lands on the assistant message and the message-details popover shows a context row.

## 0.27.1

### Patch Changes

- [#81](https://github.com/manyfold-open/manyfold/pull/81) [`1e5d661`](https://github.com/manyfold-open/manyfold/commit/1e5d661d7adc4a06e984e742f965a81e70c841bf) Thanks [@yingca1](https://github.com/yingca1)! - The daemon's hello and heartbeat now advertise `model.credential-facts`, a retroactive capability flag for the credentialFacts field its model.inspect responses already carry. No behavior change — the flag makes fleet coverage queryable from `runtime_hosts.client_features`.

## 0.27.0

### Minor Changes

- [#76](https://github.com/manyfold-open/manyfold/pull/76) [`113e790`](https://github.com/manyfold-open/manyfold/commit/113e790cf05bd7195dfbcad3c86a328274355229) Thanks [@yingca1](https://github.com/yingca1)! - `mf skills discover` is paginated: it now requests the paged discovery endpoint, gains `--sort featured|latest`, `--cursor` and `--limit` (default 100, the server max), prints a next-page hint on stderr when more results exist, and `--json` output changes shape from a bare array to the page object `{items, nextCursor}` (before: `[…summaries]`; after: `{"items":[…summaries],"nextCursor":"100"|null}` — scripts reading the JSON should switch to `.items`). The discover API route additionally emits a shape-usage telemetry event so the legacy bare-array branch has a measurable removal gate. Human-readable ordering follows the catalog's featured ranking instead of the legacy unranked order.

### Patch Changes

- [#75](https://github.com/manyfold-open/manyfold/pull/75) [`7ae7ca6`](https://github.com/manyfold-open/manyfold/commit/7ae7ca63358595e0f2507f22fad9c95d60a9dea2) Thanks [@yingca1](https://github.com/yingca1)! - Retire the legacy `A2A_TURN_TIMEOUT_MS` env fallback: a startup migration moves a still-set value into the `a2a_turn_timeouts` admin setting exactly once (never overwriting an admin's save), clamping it to the setting bounds (30s floor; 1h blocking / 24h async caps — out-of-range values change behavior and are logged), and the resolver now falls back to code defaults instead of the env var when the setting is absent. The API also warns at startup for every legacy `NCA_*`/`WEB_BASE_URL` env alias still set (key names only) and emits a telemetry event when a Lark channel delivers a pre-2.0 legacy-schema message, so both compatibility windows finally have usage signals. The daemon now advertises the `turn.budgets` capability (it has parsed split turn budgets since [#513](https://github.com/manyfold-open/manyfold/issues/513)/[#556](https://github.com/manyfold-open/manyfold/issues/556) — this makes that queryable), and `MF_CHAT_STREAM_FLUSH_MS` / `MF_TURN_ADOPT_REPOLL_MS` are documented in `.env.example`.

## 0.26.0

### Minor Changes

- [#69](https://github.com/manyfold-open/manyfold/pull/69) [`0f66aec`](https://github.com/manyfold-open/manyfold/commit/0f66aec076e7d5e6c4c070577e9e0653c9839278) Thanks [@yingca1](https://github.com/yingca1)! - The legacy device-code grant flow is removed. `mf login` loses `--poll`, `--wait`, `--scopes`, `--for-agent`, `--limit-to-agent` and `--resume` (and the pending-login file plus its automatic redemption on the next command): `mf auth ensure --scopes <list>` has been the capability-request path since the auth-model refactor, and production minted two grants through the old flow in the last thirty days. On the API, `/auth/cli/start` answers 410 with upgrade guidance when a request carries `requestedScopes`/`requestedAgentId`, `/auth/cli/poll` is a tombstone that always answers the same 410, and the approve/exchange paths refuse the (15-minute-lived) grant sessions a pre-removal deploy may leave behind — so no new `enforceAgentBinding=false` grant can be minted anywhere. Tokens the old flow already issued keep authenticating unchanged; their retirement is the auth-model refactor's Phase 8 and starts its observation window with this release.

## 0.25.0

### Minor Changes

- [#54](https://github.com/manyfold-open/manyfold/pull/54) [`f5b6347`](https://github.com/manyfold-open/manyfold/commit/f5b634742aa4bf76ebea6df73c7f52a6fcd8c311) Thanks [@yingca1](https://github.com/yingca1)! - Local config is now checked before it is trusted, and you can pick a model from
  it.

    The "Local config" model source used to treat the presence of a config
    directory as proof of a working login. Claude Code needed only `~/.claude` to
    exist; Codex accepted an `auth.json` it could not even parse; Gemini read
    `oauth_creds.json` without ever looking at the `expiry_date` inside it. On top
    of that the source skipped model validation entirely, so a signed-out machine
    advertised itself as ready and the failure only surfaced when a message was
    already on its way.

    Both inspect paths now report what they actually found — whether a token is
    present, when it expires, whether a refresh token can renew it, which
    third-party gateways `~/.codex/config.toml` configures — and the verdict is
    computed from those facts. Because the facts carry timestamps rather than a
    yes/no, a snapshot taken an hour ago stops claiming a live token without
    needing to be re-inspected. A sign-in that has expired with no way to renew is
    now reported in the composer and refused at send time; the refusal re-inspects
    the runtime first, so signing in again on that machine is enough to clear it.

    Two situations deliberately stay permissive. A daemon older than this change
    reports no facts, and a macOS host keeps its Claude token in the keychain,
    which a background daemon must not prompt for — neither can be judged, so
    both keep working exactly as before.

    Picking a model under "Local config" works now. The models your CLI reported
    are listed in the composer, alongside Claude's effort and Codex's speed and
    reasoning level, each with a "CLI default" entry that hands the decision back
    to the local CLI. Nothing is filled in on your behalf: a knob you never set
    sends no flag at all. `/model` in a channel and `mf model-config update
--model` set the model too — until now they reported success and silently
    discarded it.

    The concrete model id you pick is passed through as-is. The hosted path maps a
    version onto its family alias (`claude-sonnet-4-5` became `--model sonnet`)
    because it repoints that alias through the environment; a local CLI has no
    such indirection, so an agent whose stored model was a full id now runs that
    exact version.

    Also fixes the sandbox copy of the inspector, where an over-escaped pattern
    made `requires_openai_auth = true` unmatchable, letting a hosted runtime treat
    `OPENAI_API_KEY` as usable even when the local config required a ChatGPT
    sign-in.

## 0.24.0

### Minor Changes

- [#17](https://github.com/manyfold-open/manyfold/pull/17) [`a365fa8`](https://github.com/manyfold-open/manyfold/commit/a365fa8e2a3046e0826a13e22a824e7147508467) Thanks [@yingca1](https://github.com/yingca1)! - The installer is now manifest-driven and served from `https://manyfold.ai/cli/install.sh`.

    `install.sh` used to call the GitHub Releases API to find a release, scrape
    `browser_download_url` out of the JSON, and recover the CLI version from the
    asset filename. It now reads the same release manifest `mf update` reads, which:

    - removes the GitHub API dependency and its unauthenticated rate limit — the
      common failure mode was an installer that worked yesterday and 403s today;
    - drops the download from three requests to two, because the checksum travels
      inside the manifest instead of a detached `.sha256` that could be served from
      a different cache generation than the archive it describes;
    - stops depending on `releases/latest`, which is what makes it safe for the CLI
      to leave the edition release train;
    - supports `MF_CHANNEL=dev` for real (`staging` is accepted as the pre-rename
      alias), and `VERSION=` pins either a stable or a dev build.

    The script is also served by the web app at `/cli/install.sh`, so the advertised
    install command becomes:

    ```sh
    curl -fsSL https://manyfold.ai/cli/install.sh | sh -s -- setup
    ```

    It is a committed copy under `apps/web/public/cli/`, kept honest by a
    byte-equality test: neither the OSS nor the cloud web Dockerfile has `apps/cli`
    in scope, so a build-time copy or a symlink would break the image builds.

- [#20](https://github.com/manyfold-open/manyfold/pull/20) [`c738de9`](https://github.com/manyfold-open/manyfold/commit/c738de9aa8e21810070569ae35c752cdb0aa6bf1) Thanks [@yingca1](https://github.com/yingca1)! - `mf update` now resolves releases through a JSON manifest instead of a plaintext
  `latest/version.txt` plus a derived download path.

    The old protocol asked the CDN for a version string, then built the asset URL
    and a sibling `.sha256` URL by string concatenation. That meant three requests
    where the checksum could be served from a different cache generation than the
    bytes it described, and it hard-coded the storage layout into every installed
    binary — so the artifacts could never move.

    A channel now points at one manifest, and the manifest names every artifact by
    absolute URL with its sha256:

    - `https://github.com/manyfold-open/manyfold/releases/download/cli-channels/{stable,dev}.json`
      for the channel head, and a per-release `manifest.json` so `mf update --to`
      and the daemon's remote upgrade can still reach an arbitrary past build.
    - Two round trips instead of three, and the checksum can no longer disagree
      with the archive it covers.
    - The binary derives no URLs, so a future storage move needs a new manifest,
      not a new release of the CLI.

    **The dev channel is ordered by commit, not semver.** Consecutive dev builds
    share a base version, so the comparator reported them equal forever. Builds now
    carry their source commit and build time, and `mf version --verbose` / `--json`
    report them — the dev channel sees an update when the commit moves even though
    `x.y.z` has not.

    **The dev channel is an update policy, not an environment.** It no longer
    carries its own API endpoint: both channels default to the production API, and a
    pre-production endpoint is selected per profile with an explicit `--api-url` at
    login. `mf update --channel dev` says so when it switches.

    Also in this change:

    - New `mf version` command: bare output is byte-identical to `mf --version`,
      with `--verbose` and `--json` adding channel, commit, build time, target,
      install method and paths.
    - The daemon's background auto-updater follows the **saved** update channel.
      It previously used the baked one, so a machine where someone ran
      `mf update --channel dev` kept auto-updating along stable, silently undoing
      the choice on the next tick.
    - `mf update` and the API share one version comparator (`compareCliSemver`)
      instead of keeping a second, prerelease-blind copy in the CLI.
    - The `daemon.update` RPC reports which commit it landed on.

    Channel switching stays on `mf update --channel <dev|stable>`; no `mf channel`
    command was added, because `mf channels` already manages messaging channels and
    the singular/plural pair would be a permanent trap.

### Patch Changes

- [#15](https://github.com/manyfold-open/manyfold/pull/15) [`1909ba4`](https://github.com/manyfold-open/manyfold/commit/1909ba441c54570ff977b1399c9e08d39a2afaf7) Thanks [@yingca1](https://github.com/yingca1)! - Rename the mf CLI's pre-release update channel from `staging` to `dev`
  throughout. The channel a user selects with `mf update --channel dev` and the
  name the product reports are now the same word.

    - The runtime list labels the channel "Dev" instead of "Staging".
    - `staging` stays accepted as an alias everywhere it can arrive from an older
      peer: the `--channel` flag, a saved `~/.manyfold/update-channel.json`
      preference, the `daemon.update` RPC payload, and version strings — builds
      published before this rename are versioned `x.y.z-staging.<stamp>.<sha>` and
      are still installed in the field, so they keep reading as dev builds.
    - `GET /daemon/cli-versions` gains a `dev` list; the `staging` list is retained
      as a deprecated mirror so an older web bundle keeps working against a newer
      API during a rolling deploy.

    No distribution or update-source behaviour changes here.

- [#18](https://github.com/manyfold-open/manyfold/pull/18) [`d454437`](https://github.com/manyfold-open/manyfold/commit/d4544372f03391943400bf874f87c9bcbaac386b) Thanks [@yingca1](https://github.com/yingca1)! - The CLI now builds and publishes from this repository, on its own release train.

    Two channels, two triggers:

    - **stable** — a `cli-v<version>` tag. `release-cli` builds the five targets,
      creates the `cli-v<version>` release, then promotes that release's manifest to
      `stable.json`.
    - **dev** — every `develop` commit whose `ci` run passed. `release-cli-dev`
      builds the same five targets, attaches them to the rolling `cli-dev`
      prerelease, then rewrites `dev.json`.

    Both write the channel pointer last, so a reader never sees a manifest naming an
    artifact that is still uploading. The pointers live on a fixed `cli-channels`
    prerelease, which keeps their URLs stable forever.

    The dev channel is gated on CI completion rather than on push, because it has
    to mean "latest successful develop build" — a red build must never become the
    thing every dev machine installs.

    `ci` now also runs on `develop` pushes, and a `sync-release-to-develop`
    workflow back-merges `main` after a version PR; without it `changeset version`
    would delete consumed changesets on `main` only and the next promotion would
    resurrect them.

Notes before 0.23.3 predate this repository's public history; they live on
the docs site's changelog pages.

## 0.23.3

### Patch Changes

- `mf daemon register` now resolves its API endpoint the same way every other command does: an explicit root `--api-url` wins, then the profile's stored `apiUrl` from `mf login`, then the channel default. Previously the stored profile endpoint was skipped, so a machine logged into a self-hosted API silently tried to enrol against the default endpoint and was told its daemon token did not exist.
