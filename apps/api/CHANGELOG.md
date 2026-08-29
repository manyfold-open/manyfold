# @manyfold/api

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
