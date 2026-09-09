# @manyfold/cli

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
