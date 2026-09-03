# @manyfold/api

## 0.62.0

### Minor Changes

- [#144](https://github.com/manyfold-open/manyfold/pull/144) [`6ee91e5`](https://github.com/manyfold-open/manyfold/commit/6ee91e5679ad9e22f9f999b0b87663df5586f85a) Thanks [@yingca1](https://github.com/yingca1)! - Show the signed-in account and its usage on the runtime page, and sign in from there.

    The runtime detail page (`/settings/runtimes/<runtimeId>`) gains an Account section for Claude Code, Codex and Gemini CLI runtimes on self-owned machines and sandboxes: the signed-in identity (email, organization, plan), the sign-in status, and the subscription usage windows with their reset countdowns (Claude 5h/7d, Codex primary/secondary, Gemini per-model quota). The host reads the CLI's own credential files and calls the vendor usage endpoint itself; only the response and non-secret identity fields ever leave the machine.

    - CLI daemon: new `account.inspect` RPC, advertised through the `account.inspect` client feature. Runtime pages of daemons on older CLIs show an update prompt instead of a probe failure.
    - API: `GET /agent-runtimes/:id/account` (`?wake=1` to probe a sleeping sandbox, which starts the VM and reserves an active slot), plus a `runtimeId` target on the terminal websocket for a bare host shell.
    - Web: when the runtime is not signed in, "Sign in" opens an inline terminal on the host that starts the CLI's own headless sign-in (`claude auth login --claudeai`, `codex login --device-auth`, `NO_BROWSER=true gemini`); closing it re-checks the account. The chat sign-in card now recommends `claude auth login --claudeai` too.
    - On macOS machines the Claude and Gemini tokens live in the Keychain, which the daemon deliberately does not read, so identity shows but usage does not.

## 0.61.1

### Patch Changes

- [#120](https://github.com/manyfold-open/manyfold/pull/120) [`ecea296`](https://github.com/manyfold-open/manyfold/commit/ecea296c3c9ec06b7172e98477809b22cccf4e06) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox or cloud computer no longer reports a Claude Code sign-in that nobody performed. Seen on a self-hosted sandbox [2026-09-01]: an agent created with **Use your own subscription** showed its sign-in card for a moment, then hid it, and the first turn came back with the CLI's own `Not logged in · Please run /login`.

    The credential evaluator treated "a framework config exists" as a session it could not read, which is right on a machine the user owns — macOS keeps the Claude token in the Keychain, where no inspect pass can see it — but wrong on a container we provisioned, because `ClaudeCodeBootstrap` runs `mkdir -p "$HOME/.claude"` itself. Every fresh runtime-local sandbox therefore reported the one fact the fallback needed (`configPresent: true` with `envToken`, `credentialsFileParsed` and `oauthAccount` all false), evaluated to `unknown`, and `unknown` counts as usable. That verdict both hid the sign-in card (its visibility is `!ready`) and let the turn past `assertRuntimeLocalUsable` into a raw CLI failure.

    Judgement now takes the runtime into account: `runtimeLocalCredentialStatus` accepts a context saying whether config presence is evidence at all, and the API passes `false` for sprites and k8s while daemon runtimes keep today's benefit of the doubt. A fresh sandbox now evaluates `missing` / `no-credentials`, so the card stays up and a turn sent before signing in fails fast with "Claude Code local credentials were not detected" instead of reaching the CLI. Real credential material is unaffected on every runtime: an env token, a live or refreshable OAuth session, a `~/.claude.json` login record, and even a credentials file we can parse but not date all read exactly as before. Caches written by the old logic self-heal on the next read — the view re-evaluates stored facts, so no migration is needed. Codex and Gemini were never affected: their evidence is a credentials file, and nothing in the bootstrap creates one.

## 0.61.0

### Minor Changes

- [#112](https://github.com/manyfold-open/manyfold/pull/112) [`908cf7b`](https://github.com/manyfold-open/manyfold/commit/908cf7b725e5bfd3501bc8af6e195c0e887e31dd) Thanks [@yingca1](https://github.com/yingca1)! - Agents can now be created without platform model credentials by sending `modelConfigSource: 'runtime-local'` — the "use your own subscription" mode, where the coding CLI inside the sandbox / computer / cloud computer owns its credentials via its own sign-in. The DTO enforces a strict XOR (runtime-local carries no credential block and no `saveCredentialAs`, and is limited to claude-code / codex / gemini-cli), the resolver stores a deliberately empty encrypted payload (every reader keeps a row to decrypt, and keep-alive's report-token merge keeps working), and the bootstraps skip everything that presumes a key: the claude `--print` verify turn (which could only fail before the user signs in), `codex login --with-api-key` plus the provider-pinned `config.toml` (an empty file is still touched so MCP splices have a target, without truncating a reused sandbox's own config), gemini's credential env, and all provider keys in the k8s pod Secret (pod env would outrank the on-disk OAuth the user signs in with).

    Turn time closes the loop: sprites turns for claude-code and gemini-cli no longer inject platform credentials when the turn is runtime-local (`modelConfig` null + `runtimeLocalTuning` present) — previously an injected `ANTHROPIC_AUTH_TOKEN`/`GEMINI_API_KEY` shadowed the sandbox's own CLI sign-in even with the source switched to Local config, and gemini's per-turn settings.json rewrite flipped the auth type back to api-key. Codex sprites turns already carried no injection; that claim now has a pin test. Creating (or joining a sandbox) in this mode also persists the source choice on the paths that silently dropped it (join-instance and k8s creates) and best-effort enables the sandbox terminal, which is where the sign-in happens.

## 0.60.1

### Patch Changes

- [#105](https://github.com/manyfold-open/manyfold/pull/105) [`356a56c`](https://github.com/manyfold-open/manyfold/commit/356a56c0e982f9ebf0daa75368bb125054ceba0c) Thanks [@yingca1](https://github.com/yingca1)! - The NetMind price table now reads from that platform's new gateway. NetMind moved its client API off the old Java gateway, and the price endpoint did not survive the move as-is: `POST platform-api.netmind.ai/inference/modelPrice` has no route on the new host — a request there falls through to the catch-all middleware and answers `403 {"message":"Invalid API key"}`, which is a missing path rather than an auth failure (an invented path answers identically). The replacement is `GET inference.api.netmind.ai/v1/price/model`, still unauthenticated, and it publishes the category groups at the top level instead of wrapping them in `data`.

    The rows inside are unchanged, so the parser now accepts either envelope and everything downstream of it is untouched: the `1M Tokens` billing_type filter, the four named keys of `price_details[0]`, the per-million division, and the deliberate refusal to walk `member_price` or the competitor blocks (all of which are still present, in identical counts, on the new host). Verified against both live origins with the shipped parser: 84 models each, same key set, identical rates.

    The snapshot parse version is bumped with it. That field normally tracks a change in what the parser stores, and here the stored output is byte-identical — but a snapshot row written from the old origin also carries a fresh `fetchedAt`, and `loadSource` returns early inside the 24h TTL, so without the bump a deploy could keep serving the dead endpoint's table for a day. The bump forces one refetch at boot. A refresh that somehow parses to nothing still keeps the current table and logs a warning rather than zeroing prices, so the fleet-visible signal for this change is the `netmind` source's `entryCount` staying put with a fresh `fetchedAt`.

    The NetMind key-management API moved hosts too, but that base URL is an operator setting rather than a constant, so it needs no code change.

## 0.60.0

### Minor Changes

- [#95](https://github.com/manyfold-open/manyfold/pull/95) [`bec1b35`](https://github.com/manyfold-open/manyfold/commit/bec1b356edf0467c51632946050a1a8858245a6b) Thanks [@yingca1](https://github.com/yingca1)! - Hermes chat turns now show tool outputs and stop silently denying file edits. The ACP decoder maps terminal `tool_call_update` frames to `tool_result` events (in their own `hermes-acp-x-<n>` ordinal namespace, so a cross-deploy resume cannot re-key rows the old decoder already wrote), and both ACP clients answer `session/request_permission` with an option the request actually offers — the previous hardcoded `approve_for_session` matches no option id current hermes builds advertise, and an unknown id maps to deny on both of hermes's approval bridges, which rejected every file edit on up-to-date hermes images. Billing now also decodes the `cachedReadTokens`/`cachedWriteTokens` spellings the acp 0.9.0 prompt ack uses, so cache tokens stop falling out of usage records. Hermes's streamed `usage_update` ({used} of {size} context-window pressure — not billing) is no longer discarded: the turn's final reading lands on the assistant message and the message-details popover shows a context row.

- [#97](https://github.com/manyfold-open/manyfold/pull/97) [`6510fb7`](https://github.com/manyfold-open/manyfold/commit/6510fb7b1709402ca45062bb37db592d956c6d89) Thanks [@yingca1](https://github.com/yingca1)! - Hermes chats gain interactive permission approval. The composer's permission menu now works for hermes with three modes mirroring hermes's own edit-approval trio — "Ask for approval", "Accept edits", and "Don't ask" (the default, byte-identical to the previous always-YOLO behavior for every caller that sends no mode). In the ask modes the turn drops `HERMES_YOLO_MODE`, aligns the session via ACP `session/set_mode`, and surfaces `session/request_permission` as an interactive card in the transcript instead of auto-approving; the card's request and settlement persist as stream events AND content blocks, so it survives reconnects and history, and a turn that ends without a resolution renders the card inert. Answers are delivered with `POST …/messages/:messageId/permissions/:requestId` and routed like cancel: the in-process coordinator first, the carrying daemon via the new `turn.permission` RPC second, and a durable `chat_permission_answers` row plus pg NOTIFY for a peer-owned interactive turn (the composite PK makes the second answer a 409 — first click wins). An unanswered ask denies after `HERMES_PERMISSION_TIMEOUT_MS` (default 5 min) with the request's own reject option, and pending asks tick the turn's inactivity budget so a human deciding never reads as a hang. Ask modes on a daemon without the new `turn.hermes.permissions` capability are refused with `hermes_daemon_permissions_upgrade_required` — never silently downgraded to YOLO. The daemon publishes a synthetic `_manyfold/permission_resolution` line into the exec buffer before the child's reply, so a replayed stream reproduces the settlement in live order.

- [#98](https://github.com/manyfold-open/manyfold/pull/98) [`5701b2f`](https://github.com/manyfold-open/manyfold/commit/5701b2fa489aefb84350e2eb9ba7162849fc7218) Thanks [@yingca1](https://github.com/yingca1)! - Hermes chats can switch models per message. The composer's model menu now works for hermes agents (options come from the agent's provider-models cache, which the model-config view serves for hermes too, with a filter box once the list grows past a screenful), and the choice is applied via ACP `session/set_model` — hermes persists a session's model in its own state.db, so env vars cannot move a resumed session. Every transport reconciles by diffing against the models state hermes reports on session/new|resume: an untouched session costs no RPC, and picking "Default" re-sends the default's id because a hermes session would otherwise keep the previous pick under a UI that claims otherwise. Daemon-carried turns gate on the new `turn.hermes.options` capability: an explicit switch on an older daemon is refused with `hermes_daemon_options_upgrade_required` (never silently dropped), while the auto-defaulted value skips quietly; a hermes build that predates `session/set_model` fails an explicit switch as `hermes_set_model_unsupported`. The daemon reports the session's models/modes state on the turn final, captured best-effort into `agents.extras.hermesAcp` for diagnostics.

## 0.59.0

### Minor Changes

- [#88](https://github.com/manyfold-open/manyfold/pull/88) [`5ba3eb6`](https://github.com/manyfold-open/manyfold/commit/5ba3eb6ca97cb7716e0e30f78a4f616e261b9a32) Thanks [@yingca1](https://github.com/yingca1)! - Two read-only endpoints behind the new settings dashboards.

    `GET /me/model-providers/usage?from=&to=` returns spend, tokens, requests and
    last use grouped by model provider for the calling user. The aggregation
    already existed for admins; this is the same GROUP BY, scoped to one user and
    shared with the admin path so the two can never disagree about how spend is
    computed. Two things it does differently: the unattributed group — turns whose
    agent had no provider bound, or whose provider row was deleted — is kept
    rather than dropped, and `costUsd` is left null when nothing in the group
    carried a price, with `unpricedEventCount` saying how many turns are missing
    one. Null cost means unknown, not free.

    `GET /channels/activity?windowDays=` returns per-channel delivery counts and
    the last inbound/outbound timestamps. The counts cover a window because
    `channel_deliveries` is pruned, and the resolved `windowDays` comes back in the
    response clamped to the deployment's `CHANNEL_DELIVERY_RETENTION_DAYS`, so a
    host that keeps seven days can never have a seven-day count labelled as thirty.
    Timestamps come from `channel_sessions`, which is never pruned, so they are
    lifetime values. Inbound counts every delivery; outbound counts only the ones
    that reached the platform.

    No migration — both queries are served by existing indexes.

## 0.58.0

### Minor Changes

- [#81](https://github.com/manyfold-open/manyfold/pull/81) [`1e5d661`](https://github.com/manyfold-open/manyfold/commit/1e5d661d7adc4a06e984e742f965a81e70c841bf) Thanks [@yingca1](https://github.com/yingca1)! - `chat.stream.error` telemetry now reports `causeVia` (`code | message | daemon_transport | code_unmapped | none`) beside `cause`, naming which classifier branch answered. Operators can now count how often the legacy message-matching fallback still carries a classification and how many terminals arrive under a specific code with no durable mapping — the two numbers gating that fallback's removal. No classification behavior changed.

- [#82](https://github.com/manyfold-open/manyfold/pull/82) [`95c70a4`](https://github.com/manyfold-open/manyfold/commit/95c70a46389e4725272ee3e484196defcaa565f1) Thanks [@yingca1](https://github.com/yingca1)! - The legacy k8s hermes dashboard host is removed. The dashboard toggle and the control-UI URL mint now reject k8s runtimes (sprite dashboards are unchanged), and the cookie-auth endpoints that served the `-dashboard` ingress (`POST /agent-runtimes/dashboard-ticket`, `GET /agent-runtimes/:id/dashboard-auth-check`) are gone, together with the `MF_AUTH_URL` / `MF_DASHBOARD_COOKIE_DOMAIN` / `MF_DASHBOARD_SIGNIN_URL` configuration (no reader is left; set values are inert). Measured on prod and staging [2026-08-28]: zero k8s runtimes had the dashboard enabled.

## 0.57.0

### Minor Changes

- [#75](https://github.com/manyfold-open/manyfold/pull/75) [`7ae7ca6`](https://github.com/manyfold-open/manyfold/commit/7ae7ca63358595e0f2507f22fad9c95d60a9dea2) Thanks [@yingca1](https://github.com/yingca1)! - Retire the legacy `A2A_TURN_TIMEOUT_MS` env fallback: a startup migration moves a still-set value into the `a2a_turn_timeouts` admin setting exactly once (never overwriting an admin's save), clamping it to the setting bounds (30s floor; 1h blocking / 24h async caps — out-of-range values change behavior and are logged), and the resolver now falls back to code defaults instead of the env var when the setting is absent. The API also warns at startup for every legacy `NCA_*`/`WEB_BASE_URL` env alias still set (key names only) and emits a telemetry event when a Lark channel delivers a pre-2.0 legacy-schema message, so both compatibility windows finally have usage signals. The daemon now advertises the `turn.budgets` capability (it has parsed split turn budgets since [#513](https://github.com/manyfold-open/manyfold/issues/513)/[#556](https://github.com/manyfold-open/manyfold/issues/556) — this makes that queryable), and `MF_CHAT_STREAM_FLUSH_MS` / `MF_TURN_ADOPT_REPOLL_MS` are documented in `.env.example`.

### Patch Changes

- [#76](https://github.com/manyfold-open/manyfold/pull/76) [`113e790`](https://github.com/manyfold-open/manyfold/commit/113e790cf05bd7195dfbcad3c86a328274355229) Thanks [@yingca1](https://github.com/yingca1)! - `mf skills discover` is paginated: it now requests the paged discovery endpoint, gains `--sort featured|latest`, `--cursor` and `--limit` (default 100, the server max), prints a next-page hint on stderr when more results exist, and `--json` output changes shape from a bare array to the page object `{items, nextCursor}` (before: `[…summaries]`; after: `{"items":[…summaries],"nextCursor":"100"|null}` — scripts reading the JSON should switch to `.items`). The discover API route additionally emits a shape-usage telemetry event so the legacy bare-array branch has a measurable removal gate. Human-readable ordering follows the catalog's featured ranking instead of the legacy unranked order.

## 0.56.0

### Minor Changes

- [#69](https://github.com/manyfold-open/manyfold/pull/69) [`0f66aec`](https://github.com/manyfold-open/manyfold/commit/0f66aec076e7d5e6c4c070577e9e0653c9839278) Thanks [@yingca1](https://github.com/yingca1)! - The legacy device-code grant flow is removed. `mf login` loses `--poll`, `--wait`, `--scopes`, `--for-agent`, `--limit-to-agent` and `--resume` (and the pending-login file plus its automatic redemption on the next command): `mf auth ensure --scopes <list>` has been the capability-request path since the auth-model refactor, and production minted two grants through the old flow in the last thirty days. On the API, `/auth/cli/start` answers 410 with upgrade guidance when a request carries `requestedScopes`/`requestedAgentId`, `/auth/cli/poll` is a tombstone that always answers the same 410, and the approve/exchange paths refuse the (15-minute-lived) grant sessions a pre-removal deploy may leave behind — so no new `enforceAgentBinding=false` grant can be minted anywhere. Tokens the old flow already issued keep authenticating unchanged; their retirement is the auth-model refactor's Phase 8 and starts its observation window with this release.

### Patch Changes

- [#66](https://github.com/manyfold-open/manyfold/pull/66) [`77b8724`](https://github.com/manyfold-open/manyfold/commit/77b872411022a917b3325b5a5b87c7a3ac944d57) Thanks [@yingca1](https://github.com/yingca1)! - Retire three expired compatibility windows recorded in the legacy inventory: the `nca_auth_`/`nca_dvc_` login-code prefixes are no longer accepted (minting went `mf_`-only at the 2026-06-11 rename and login codes live 15 minutes, so no live legacy code can exist — a legacy-shaped code now gets 400 instead of 404), the stateless v1 consent-token claims shape is no longer resolved (v2 `{id, v: 2}` tokens have been the only mint since the consent table landed, and v1 tokens expired within their hour), and `CliVersionCatalog` no longer carries the deprecated `staging` mirror of `dev` (zero readers since the GitHub-Releases cutover). Also removes the retired-but-never-minted `rti`/`rir` ObjectId prefixes (kept as a retired-prefix comment so they are never reused), the six `docker-build-*` justfile recipes that point at a `docker/` tree this repository does not contain, orphan env-template variables with no reader, and adds the missing `deleted_user_billing_refs` entry to the editions cloud-table contract so the boundary lint denies it like every other cloud table.

- [#68](https://github.com/manyfold-open/manyfold/pull/68) [`d76fb1c`](https://github.com/manyfold-open/manyfold/commit/d76fb1cc79ec49f9fa428daf550b7c944aa7726a) Thanks [@yingca1](https://github.com/yingca1)! - Retire two legacy paths whose removal gates were verified against production and staging (zero live rows in both): the `a2a-ephemeral` token kind is fully mint-retired — the mint parameter and auth-principal unions drop it, bearer verification fails loud on the (impossible-by-TTL) residue row, the hourly ephemeral-token reaper now also drains expired `a2a-ephemeral` rows left by deploys predating the stateless-ticket switch, and the column enum keeps the value only so pre-switch rows stay readable — and the pre-rename `nca_dashboard` cookie fallback in k8s dashboard auth is gone (the cookie's Max-Age is one hour, so none planted before the rename can exist).

## 0.55.0

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

### Patch Changes

- [#55](https://github.com/manyfold-open/manyfold/pull/55) [`d01d06b`](https://github.com/manyfold-open/manyfold/commit/d01d06b3454d99a0a5d156535fc50b0c1c0df400) Thanks [@yingca1](https://github.com/yingca1)! - Self-hosted accounts created before the deployment set `MF_DEFAULT_PLAN_ID`
  no longer keep cloud `free` limits forever. That variable only ever applied to
  the `users` INSERT, so an account created by an older self-host stack landed
  on `free` and nothing — not upgrades, not migrations, not logging back in —
  ever moved it. The symptom was a quota error naming a plan the operator never
  chose, such as `External API limit reached (3 for Free plan)` when adding a
  fourth Dify / Langflow / A2A agent. On the first start after upgrading, a
  deployment with no billing module and `MF_DEFAULT_PLAN_ID` set to something
  other than `free` moves every remaining `free` account to that plan. It runs
  once, claims its marker in the same transaction as the update, and records the
  move in the audit log — so a later deliberate assignment is never overwritten,
  and a cloud deployment is never touched.

    The admin console gains a **Plan** card on user detail, backed by
    `GET /admin/plans` and `PATCH /admin/users/:id/plan`. Until now the
    open-source composition root had no way to change a user's plan at all, since
    plan changes lived only in the cloud billing module; recovery meant editing
    the database by hand. The route refuses on deployments where billing owns the
    assignment, so a subscription can't be silently desynced from what a user pays
    for.

    `MF_SELFHOST_DEFAULT_PLAN_ID` now overrides the compose stack's default tier
    for new accounts, and self-hosting docs cover how to read and change a user's
    plan.

## 0.54.0

### Minor Changes

- [#56](https://github.com/manyfold-open/manyfold/pull/56) [`8cc72c1`](https://github.com/manyfold-open/manyfold/commit/8cc72c1d3a38049fd039f6d9489e8b19dbeeaf00) Thanks [@yingca1](https://github.com/yingca1)! - Every hermes chat turn now speaks ACP. A daemon-runtime turn requires a daemon
  that advertises `turn.hermes` — one that does not gets a non-retryable error
  naming the fix (`mf update`) instead of the retired in-API pipe fallback. A
  sprite turn prefers its runner-owned `turn.start` (resumable, now attempted
  unconditionally rather than behind the rollout allowlist), and falls back to an
  API-driven `hermes acp` over the interactive sprite exec channel; a k8s turn
  runs the same client over an interactive pod exec. The OpenAI-compatible
  gateway POST that used to carry sprite-without-runner and k8s turns is gone
  from chat entirely — the resident gateway keeps serving health probes and the
  dashboard. The `MF_HERMES_TURN_RPC` and `MF_HERMES_ACP_RESUME` flags are
  retired; resume is always on for daemon-carried turns.

    Two long-standing gaps are fixed on the way: an exec'd or runner-spawned
    `hermes acp` never saw the resident service env, so the provider alias key
    (`OPENROUTER_API_KEY` et al) and the agent Environment extras now ride each
    dispatch — before this, a sprite hermes agent on a non-`custom` provider had
    no API key at all on the runner path; and managed pool exhaustion is now
    classified from the fatal stderr line, keeping the managed-channel breaker
    working where the gateway 503 body used to carry the signal.

    One accepted behaviour change: hermes now holds the conversation state in its
    own sessions (created via `session/new` / resumed via `session/resume`)
    instead of receiving a truncated 30-message history each turn. An existing
    session's first post-upgrade turn starts a fresh hermes session, so hermes
    will not remember the pre-upgrade conversation; the history stays visible in
    Manyfold. `HERMES_HISTORY_BUDGET` leaves `@manyfold/shared` with the stateless
    path that read it.

## 0.53.1

### Patch Changes

- [#48](https://github.com/manyfold-open/manyfold/pull/48) [`c491d19`](https://github.com/manyfold-open/manyfold/commit/c491d1996c03a3f69d8c14337ca701023cb2257d) Thanks [@yingca1](https://github.com/yingca1)! - A WhatsApp registration whose pairing socket cannot be opened now fails
  instead of sitting in the pending state forever. Nothing polls a registration
  whose start threw and the sweeper only removes rows an hour past expiry, so
  each failed attempt used to hold one of the three per-user slots for its full
  eight-minute lifetime — the fourth attempt then reported "too many pending
  registrations", which named the wrong problem entirely. Start now answers with
  a 502 `whatsapp_registration_unavailable`, and a socket that cannot be
  reopened during a QR refresh fails its row the same way.

    The per-user cap also counts only registrations that are genuinely live.
    Cancelled, failed and expired attempts stopped holding capacity the moment
    they settled, for both WhatsApp and WeChat. And a Baileys import that fails is
    retried on the next attempt rather than being remembered, so one bad load no
    longer answers every request for the life of the process.

## 0.53.0

### Minor Changes

- [#33](https://github.com/manyfold-open/manyfold/pull/33) [`95e4991`](https://github.com/manyfold-open/manyfold/commit/95e499187d2208c7dede9d6bd216bf4c3fb522fc) Thanks [@yingca1](https://github.com/yingca1)! - Agents can now be reached from a LINE Official Account. Create a Messaging API
  channel in the LINE Developers console, paste the channel secret and a
  long-lived channel access token, and Manyfold sets the webhook URL and captures
  the bot identity for you.

    The channel works in one-on-one chats and in groups and multi-person rooms,
    with the usual allowed-user, operator and mention-only gating; group mentions
    use LINE's own `isSelf` flag rather than name matching. Inbound images, video,
    audio and files reach the turn, replies are chunked to LINE's 5,000-character
    limit, and a group reply quotes the message that triggered it.

    Two limits come from the platform. LINE has no message-edit API, so replies are
    final-only — there is no live preview. Outbound media needs publicly hosted
    URLs, so the agent's file links stay in the text. Replies are push messages and
    count against the LINE plan's monthly quota.

    Two console settings still need a human: turn **Use webhook** on (the channel's
    Test action reports when it is off) and turn auto-reply messages off, or LINE
    answers alongside the agent.

- [#32](https://github.com/manyfold-open/manyfold/pull/32) [`329ce8c`](https://github.com/manyfold-open/manyfold/commit/329ce8c974cf0e45f8f42bde959d772b370c8703) Thanks [@yingca1](https://github.com/yingca1)! - Added a WhatsApp channel. Create one under Settings -> Channels, scan the QR
  code from your phone's **Linked devices** screen, and the agent starts
  answering on that number — no token to paste, no webhook to expose, no Meta
  Business account.

    Direct messages and group chats are both supported. Groups are mention-gated by
    default (a reply to the agent counts as addressing it) and can be restricted to
    specific group jids. Allowed and operator senders accept either a phone number
    or a raw jid. Inbound images and documents reach the agent as attachments, and
    files the agent links come back as images or documents. The triggering message
    is marked 👀 while the agent works, then ✅ or ❌.

    Two things worth knowing before you link a number. Linking runs through
    WhatsApp Web, which Meta does not officially support for automated use, so use
    a number you can dedicate to the agent rather than your personal one. And if
    the linked device is later removed from the phone, the stored session cannot be
    revived — delete the channel and scan again.

### Patch Changes

- [#23](https://github.com/manyfold-open/manyfold/pull/23) [`2e6fc28`](https://github.com/manyfold-open/manyfold/commit/2e6fc28a34c51d511be3358673bcbcf165488be1) Thanks [@yingca1](https://github.com/yingca1)! - The edition release (`v*`) no longer carries mf CLI binaries. The CLI has its
  own release train (`cli-v*`), so a CLI fix no longer waits for an edition
  release, and the edition tag no longer implies a CLI version it never matched.

    Install the CLI with `curl -fsSL https://manyfold.ai/cli/install.sh | sh`, or
    pick a build from the `cli-v*` releases. Nothing needs to change for existing
    installs: the installer resolves a channel manifest, not `releases/latest`.

## 0.52.0

### Minor Changes

- [#19](https://github.com/manyfold-open/manyfold/pull/19) [`582285d`](https://github.com/manyfold-open/manyfold/commit/582285dbbcf8e6168102b4abbba8b886323f2a6b) Thanks [@yingca1](https://github.com/yingca1)! - The API and web app now point at `https://manyfold.ai/cli/install.sh` and read
  CLI versions from the release manifests instead of the CDN.

    - The copy-paste install commands in the runtime dialogs, and the install script
      the API runs inside sprites, all use the one installer URL. The channel now
      rides `MF_CHANNEL=dev` rather than a separate staging URL.
    - `GET /daemon/cli-versions` lists stable releases from
      `manyfold-open/manyfold` and reports the dev channel as the single build its
      manifest names — a rolling channel has exactly one installable build by
      definition.
    - Versions below `0.24.0` are filtered out of the stable list: they have no
      per-version manifest, so a pinned upgrade to one could not be resolved by the
      current CLI or installer. Offering it would hand the operator an upgrade that
      fails at download time.
    - The daemon's latest-version probe reads the channel manifest and now also
      reports the target commit, which is what distinguishes two dev builds that
      share a version.

    **Operator-visible:** the API no longer reads `R2_S3_ENDPOINT`,
    `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` or `R2_PUBLIC_BUCKET` for the CLI
    version catalog — listing dev builds out of an object store is gone. Those
    variables are still used by other features; nothing needs to change to deploy
    this, and they can be retired from the CLI catalog's perspective.

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
