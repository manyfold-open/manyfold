# @manyfold/api

## 0.76.4

### Patch Changes

- [#295](https://github.com/manyfold-open/manyfold/pull/295) [`70c24ec`](https://github.com/manyfold-open/manyfold/commit/70c24ec1870bf210be935c4ede7445d4be945d19) Thanks [@yingca1](https://github.com/yingca1)! - Finish the Phase 8 database contract after the switch release is running: remove the retired agent-binding column, CLI grant session columns, and user-grant index. Drain retired A2A ephemeral credentials while retaining External A2A grants and their target/caller indexes. Deployments must run the switch release on every API instance before applying this contract.

## 0.76.3

### Patch Changes

- [#302](https://github.com/manyfold-open/manyfold/pull/302) [`ae1dd05`](https://github.com/manyfold-open/manyfold/commit/ae1dd05c14776e00811e1b9c29edc4593513f12d) Thanks [@yingca1](https://github.com/yingca1)! - Keep External A2A grants target-bound during a rolling Phase 8 upgrade while leaving personal tokens unbound. A temporary database trigger maintains the binding flag for older API readers when switch writers omit it. Deploy this preparation release across the fleet before the separate column-removal release, which also removes the trigger.

## 0.76.2

### Patch Changes

- [#296](https://github.com/manyfold-open/manyfold/pull/296) [`d1ab6b5`](https://github.com/manyfold-open/manyfold/commit/d1ab6b5baa4837222aef6194c23d6a90ef4751a0) Thanks [@yingca1](https://github.com/yingca1)! - Keep a single managed activation directory in framework tool-child PATH after login and repeated execution, including Gemini bootstrap and direct Sprite execution.

## 0.76.1

### Patch Changes

- [#293](https://github.com/manyfold-open/manyfold/pull/293) [`1b6ad5f`](https://github.com/manyfold-open/manyfold/commit/1b6ad5f1a50f601935b69de878ccd00b4a641d6e) Thanks [@yingca1](https://github.com/yingca1)! - Preserve External A2A target binding while rejecting retired agent bearer grants. The migration checks that legacy identities have been reconciled and keeps old columns until the switch release has reached every API instance.

- [#287](https://github.com/manyfold-open/manyfold/pull/287) [`86b872a`](https://github.com/manyfold-open/manyfold/commit/86b872a4e98422eebec26a01cfb50c96d7759ae2) Thanks [@yingca1](https://github.com/yingca1)! - Sprite shell reconciliation now removes duplicate managed activation directories
  from inherited PATH values. Login shells keep one activation entry first while
  preserving custom paths, empty entries and all other directories in their original order.

## 0.76.0

### Minor Changes

- [#288](https://github.com/manyfold-open/manyfold/pull/288) [`6b4d090`](https://github.com/manyfold-open/manyfold/commit/6b4d090f692764c94d2367b014e153b2c63d2dcd) Thanks [@yingca1](https://github.com/yingca1)! - Retire the Phase 8 user-grant compatibility layer. The API no longer exposes the legacy CLI poll route or bearer-grant endpoint, runtime authorization no longer uses `enforce_agent_binding`, and the web CLI approval screen keeps only browser login. External A2A grants remain supported.

## 0.75.0

### Minor Changes

- [#280](https://github.com/manyfold-open/manyfold/pull/280) [`193dfe4`](https://github.com/manyfold-open/manyfold/commit/193dfe4803346a0dc331a4f9500d9ca9fd160ac2) Thanks [@yingca1](https://github.com/yingca1)! - Runtime auth profiles (P2, execution contract): an agent can be bound to one of its runtime's auth profiles (`PATCH /agents/:id/runtime-auth`, compare-and-set on a binding version; also at create/attach via `runtimeAuthProfileId`), and every execution for that agent — chat turns over the daemon or the sprite runner, the agent terminal, and the model-capability probe — then runs inside that profile's credential context. The daemon (capability `auth-context.v1`) composes the context itself from an opaque `authSelection`: the profile's own credential files, every ambient vendor variable stripped from both the machine environment and the agent's extras, codex's state databases pinned to the native home, and the profile lock held for the process's lifetime so same-profile work runs serially. A host that cannot honour the selection (a bare sandbox without its runner, a pod, or an older mf CLI) refuses the execution rather than answering with the machine's native sign-in. Switching takes effect for the next execution; a turn already running keeps the context it started with.

- [#279](https://github.com/manyfold-open/manyfold/pull/279) [`055590f`](https://github.com/manyfold-open/manyfold/commit/055590fed25f93c2cad88a8527e8d7c55b916a08) Thanks [@yingca1](https://github.com/yingca1)! - Runtime auth profiles (P1, host store and management API): a coding-CLI runtime can now hold several vendor sign-ins, each in its own credential context on the host. The daemon gains `auth.list` / `auth.create` / `auth.inspect` / `auth.logout` / `auth.operation` RPCs and an `authLogin` mode for `pty.open` (capability `auth-profiles.v1`); a profile's view symlinks sessions, history and config back to the native CLI home so switching auth never forks configuration or transcripts. The API adds `/agent-runtimes/:id/auth-profiles` (list, create, inspect, login, logout, remove), `/agent-runtimes/:id/default-auth` and `/runtime-auth-operations/:id`, with profile metadata, operations and the agent binding columns in new tables. Executing a turn under a profile and the web UI follow in later releases; the existing ambient account probe is unchanged.

### Patch Changes

- [#283](https://github.com/manyfold-open/manyfold/pull/283) [`2e3d2ee`](https://github.com/manyfold-open/manyfold/commit/2e3d2eecfc99abb4be1eaf522ad82c7e5a079c38) Thanks [@yingca1](https://github.com/yingca1)! - Closing the sign-in terminal of an added account no longer leaves its login operation stuck as running. The verdict is journaled by the daemon only once the sign-in shell has exited, which is a moment after the terminal socket closes; the close-time reconcile now waits for that verdict, and reading an operation that is still open re-checks the host so a late verdict is picked up by the page's own poll.

## 0.74.0

### Minor Changes

- [#267](https://github.com/manyfold-open/manyfold/pull/267) [`5c72234`](https://github.com/manyfold-open/manyfold/commit/5c722344dec8671d8540ab171167159584beacbc) Thanks [@yingca1](https://github.com/yingca1)! - Kubernetes coding agents can now run their chat turns through a daemon that
  lives inside their own pod, instead of through `kubectl exec`.

    Until now a pod ran no Manyfold process at all: every turn was driven from
    outside over a pod exec stream. That had two costs. A turn could not survive an
    API restart, because a pod exec has no sequence and no buffer to replay from.
    And a pod's environment was written once, when it was provisioned — so an
    agent's connected-service tokens and its own environment variables never
    reached a Kubernetes agent, and the agent id baked into the pod named whichever
    agent created it, which is the wrong one for every other agent sharing that pod.

    The agent images now carry the `mf` binary, and the coding images start the
    daemon as their main process. It enrols itself with a credential the platform
    writes into the pod's environment, and registers as a platform-managed host
    that stays out of quota and out of the user's machine list. From there a coding
    turn takes exactly the same transport a sandbox runner turn already took, so it
    becomes resumable and carries per-agent environment on every dispatch.

    This is opt-in per agent through `MF_POD_RUNNER_AGENTS`, and every failure
    degrades: no runner, an offline runner, a daemon below the supported CLI floor,
    or a workspace that cannot be registered all fall back to the pod exec
    transport, whose own behaviour is unchanged. (The pod's environment does gain
    the daemon's registration keys, which every process in the container can see,
    exactly as a sandbox runner's processes see its profile.) The daemon inside a
    pod never updates itself — it reports its startup as unmanaged, which makes it
    refuse remote upgrades and disable background updates, so its version moves
    only when the image tag does.

    Service frameworks are deliberately not included: their Kubernetes runtime is
    the resident gateway itself, so a daemon beside it would be a second view of one
    instance rather than a new transport.

## 0.73.0

### Minor Changes

- [#257](https://github.com/manyfold-open/manyfold/pull/257) [`2e0af78`](https://github.com/manyfold-open/manyfold/commit/2e0af78941076c2ae2ef15217e082fb533d15ec4) Thanks [@yingca1](https://github.com/yingca1)! - Every openclaw chat turn now speaks ACP. A sprite or k8s turn runs the
  `openclaw acp` bridge in-box over the exec channel; a BYOD daemon turn runs it
  against the host's own gateway. The OpenAI-compatible gateway POST and the
  runner-held SSE variant that used to carry these turns are gone from openclaw
  entirely — NarraNexus keeps both, unchanged, as their only framework.

    `MF_OPENCLAW_ACP` is retired: it defaulted on and setting it now does nothing.
    `MF_OPENCLAW_TURN_RPC` is unchanged and still gates NarraNexus's runner
    transport.

    Two accepted behaviour changes on BYOD daemons, both refusals that name their
    own fix rather than silent fallbacks:

    - A daemon whose `mf` CLI predates the openclaw ACP turn is refused with
      `openclaw_daemon_upgrade_required` — run `mf update` on that host and restart
      the daemon. The legacy `openclaw agent --local --json` spawn it used to fall
      back to has been removed.
    - A daemon host with no openclaw gateway for the bridge to reach is refused
      with `openclaw_daemon_gateway_unavailable`, naming the port and
      `openclaw gateway start`. Manyfold still only discovers that gateway and
      never starts one. Because the daemon re-probes on its detect interval rather
      than per turn, an unreachable gateway is a retryable refusal while a missing
      configuration is not.

    Openclaw sprite turns no longer bring up a runner. With the runner rollout at
    `*` every openclaw turn was paying for a runner whose handle the ACP path then
    ignored, and the turn was stamped with a resume reference no later recovery
    could honour — a hello could terminalize a perfectly healthy turn. Resume for
    openclaw is now daemon-only; a sprite or k8s turn reports
    `openclaw_resume_unsupported`.

### Patch Changes

- [#254](https://github.com/manyfold-open/manyfold/pull/254) [`fb7c167`](https://github.com/manyfold-open/manyfold/commit/fb7c1676850187a469619d29d70f842c2027c5da) Thanks [@yingca1](https://github.com/yingca1)! - Make lazy daemon identity creation concurrency-safe so concurrent first turns reuse the same active credential.

- [#252](https://github.com/manyfold-open/manyfold/pull/252) [`4b96e8c`](https://github.com/manyfold-open/manyfold/commit/4b96e8c929670b4a1827701444844b267a4dca32) Thanks [@yingca1](https://github.com/yingca1)! - Migrate legacy sprite runtime identities into encrypted storage before CLI or framework upgrades clean shared shell profiles.

## 0.72.0

### Minor Changes

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

- [#244](https://github.com/manyfold-open/manyfold/pull/244) [`e204c5f`](https://github.com/manyfold-open/manyfold/commit/e204c5f0f452d407e9722634a6e02bc2e8bf5494) Thanks [@yingca1](https://github.com/yingca1)! - Route openclaw chat over ACP by default. `MF_OPENCLAW_ACP` now defaults on, so sprite (no-runner) and k8s openclaw turns run the `openclaw acp` bridge — enabling per-message model switching and interactive permission approval — instead of the stateless gateway-http path. Set `MF_OPENCLAW_ACP=0` to fall back to gateway-http without a redeploy. NarraNexus is unaffected (it keeps the gateway-http path via the framework guard). The gateway-http chat branch is retained as that rollback for now and will be removed in a follow-up, once the NarraNexus/GatewayHttp adapter split lands.

### Patch Changes

- [#243](https://github.com/manyfold-open/manyfold/pull/243) [`95a31eb`](https://github.com/manyfold-open/manyfold/commit/95a31eb1f773a54b71303bcdc1e796e3a8e6877a) Thanks [@yingca1](https://github.com/yingca1)! - Stop a codex thread's single-writer rule from costing a conversation. Codex admits one writer per thread and refuses the second with `thread/resume failed: … already has an active writer (code -32600)`, in the same `thread/resume failed` wrapper it puts on a missing rollout — so the resume-load self-heal matched it and cleared `framework_session_ref`, forking the session onto a fresh thread and silently dropping the conversation the user was still reading, while the holder went on appending to the thread nothing pointed at any more. The self-heal is now keyed on positive evidence of a lost rollout rather than on that wrapper, so no other reason codex wraps the same way can trigger it either; the busy refusal keeps the ref, fails retryably, is classified as its own `resume_contention` failure cause instead of a stale ref, and — when it is the session's own TUI holding the thread — is explained in the chat as such instead of shown as a JSON-RPC line.

    The terminal's "resume this session in the TUI" no longer walks into the same collision. The API refuses it while `chat_sessions.inflight_message_id` is held — which stays held through a SUSPENDED turn, the exact state where the API has stopped watching and the CLI has not stopped writing — opens a plain shell, and reports the verdict on the terminal's `session_info` frame. The web records that verdict on the tab (its own stream view both lags and leads it), explains the plain shell from it, and rebuilds the tab into the TUI on the first switch back after the turn ends — including after a mid-turn reload, where the tip message id never moves.

    Turn adoption now holds the sandbox awake while it recovers a sprites turn from the runtime transcript: that recovery polls the sandbox for the turn's remaining life, none of which is platform-visible activity, so it was racing a suspend that could freeze the very files it was reading. Every path that holds a turn's awake lease now settles it by one rule — released only at a real terminal, left on its TTL when the turn suspended or moved to another owner — and releasing waits for the lease's own in-flight create, so a hold settled on its first poll can no longer leak a full-TTL lease.

- [#241](https://github.com/manyfold-open/manyfold/pull/241) [`906f4e5`](https://github.com/manyfold-open/manyfold/commit/906f4e53a25f8da3973d5e2a5353aeba6d7a74c4) Thanks [@yingca1](https://github.com/yingca1)! - Fix openclaw chat over ACP failing on sprites with `openclaw acp exited with code 1`. The bridge now creates and enters the agent workspace itself instead of passing it as the exec working directory — a fresh sprite creates that workspace lazily, so `cd`-ing into it failed before openclaw started — and the gateway session binds to the sprite gateway's actual agent (`main`) rather than the internal agent id, which the gateway rejects as "no longer exists in configuration". Per-message model switching over ACP now takes effect.

## 0.71.3

### Patch Changes

- [#234](https://github.com/manyfold-open/manyfold/pull/234) [`873de31`](https://github.com/manyfold-open/manyfold/commit/873de313087cd7bc77f2dce4cbf8ac6a434b9a93) Thanks [@yingca1](https://github.com/yingca1)! - Surface the gateway's `data.details` in ACP turn errors instead of collapsing them to a bare "Internal error". The openclaw/hermes gateway returns a generic top-level message (`-32603 Internal error`) and puts the real cause — a provider rejection, an invalid parameter, a model error — in `error.data.details`. The ACP client dropped it, so a failed turn showed only "Internal error" with no way to tell what actually went wrong. Now the chat error reads e.g. `Internal error: model gpt-5.6-terra: <provider message>`.

## 0.71.2

### Patch Changes

- [#227](https://github.com/manyfold-open/manyfold/pull/227) [`f0c10ea`](https://github.com/manyfold-open/manyfold/commit/f0c10ea08b24c274b94ea00083ae03262171f056) Thanks [@yingca1](https://github.com/yingca1)! - Fix openclaw model switching (and a 400 it caused) by preferring the ACP path over the runner turn-rpc path when `MF_OPENCLAW_ACP` is on. A per-message model switch can only be carried by the ACP transport (an in-box `sessions.patch` on the stateful gateway session); the gateway-http and turn-rpc `model` field is only an agent router (`openclaw` / `openclaw/<agentId>`) and the gateway rejects a provider model there with a 400. Previously the runner turn-rpc path shadowed ACP whenever a sprite was runner-routed (which `MF_SPRITE_RUNNER_AGENTS='*'` makes universal), so switching silently did nothing — and a short-lived attempt to put the picked model in the request body made the gateway 400 (`Invalid model. Use openclaw or openclaw/<agentId>`). Now `viaAcp` takes precedence over `viaTurnRpc` when the flag is on, so a switched openclaw turn runs over ACP where the pick actually applies; with the flag off, turn-rpc/gateway-http are unchanged and always send the agent router in the body.

## 0.71.1

### Patch Changes

- [#219](https://github.com/manyfold-open/manyfold/pull/219) [`dc4c658`](https://github.com/manyfold-open/manyfold/commit/dc4c6588d712bd3bd619f8713741b46f75c72075) Thanks [@yingca1](https://github.com/yingca1)! - Fix openclaw per-message model switching on the non-ACP transports. The web model switcher sends a per-message model override for openclaw agents, but the API applied it only on the ACP path (via `sessions.patch`). On the runner turn-rpc and gateway-http transports — which is where every sprite openclaw agent runs when `MF_SPRITE_RUNNER_AGENTS` routes it to a runner — the override was dropped and the turn ran on the agent's stored default. The override now rides the gateway-http request body as `primary/<pick>` on both transports, so switching the model takes effect regardless of whether `MF_OPENCLAW_ACP` is on. Seen on staging: an openclaw sprite switched to gpt-5.6-terra still answered on its default because the sprite-runner rollout (`*`) sends it through turn-rpc.

## 0.71.0

### Minor Changes

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

- [#214](https://github.com/manyfold-open/manyfold/pull/214) [`2ad1d15`](https://github.com/manyfold-open/manyfold/commit/2ad1d15137d8452c0468b50f3e8f85381cb93370) Thanks [@yingca1](https://github.com/yingca1)! - Add the openclaw ACP transport for BYOD daemons (ADR-0027, O6), behind `MF_OPENCLAW_ACP`. The daemon now discovers the host's own resident openclaw gateway from its config on the heartbeat — port and reachability only, never the token, and never starting it — and reports it on the openclaw `DetectedFramework`. When the flag is on and the daemon advertises `turn.openclaw.acp`, a daemon openclaw chat turn is driven as `openclaw acp` against that gateway (the daemon is the ACP client, exactly like a hermes turn) instead of spawning `openclaw agent --local --json`: continuity is the gateway session key (`_meta.sessionKey`, never `session/resume`), the ask mode and per-message model pick are pre-patched in-box over the loopback gateway before the bridge starts, the approval card relays through the existing `turn.permission` RPC, and the turn's token usage is read back from the gateway transcript after the prompt (the ACP stream carries none) and billed. The turn is resumable — the daemon buffers the ACP frames, replayed via `exec.resume`. With the flag off, or against a daemon whose CLI predates the capability, the daemon keeps the legacy CLI-spawn path unchanged.

### Patch Changes

- [#213](https://github.com/manyfold-open/manyfold/pull/213) [`6cdc575`](https://github.com/manyfold-open/manyfold/commit/6cdc57519ee723b4bf29bbc6954429446bb9c842) Thanks [@yingca1](https://github.com/yingca1)! - Bill openclaw ACP turns. The `openclaw acp` stream carries no token usage, so a turn that completes now reads its usage back from the gateway transcript with one in-box `sessions.get` on the session key and sums every model call after the turn's own user message — the same figure the gateway-http path bills, tool loops included. A read-back that fails or cannot be attributed is logged and counted (`openclaw_acp_usage`), never fatal. The bridge is also exec'd behind a wrapper that terminates it on stdin EOF: `openclaw acp` ignores EOF, which cost every turn the ACP client's full close grace and, on k8s, left the bridge running in the pod. Still behind `MF_OPENCLAW_ACP`.

## 0.70.0

### Minor Changes

- [#207](https://github.com/manyfold-open/manyfold/pull/207) [`575b309`](https://github.com/manyfold-open/manyfold/commit/575b3094d06e2f1f585324668f89ad8ef9d13c1a) Thanks [@yingca1](https://github.com/yingca1)! - Add an API-driven ACP transport for openclaw chat turns on the sprites-no-runner and k8s cells, behind `MF_OPENCLAW_ACP` (default off). When enabled, the adapter drives `openclaw acp` — a bridge to the resident gateway — over the interactive exec transport using the shared `AcpTurn` client, replacing the stateless gateway-HTTP path (30-message resend) with the gateway's own server-side history keyed by a deterministic `_meta.sessionKey`. narranexus keeps the gateway-HTTP path (the ACP branch is guarded on `framework === 'openclaw'`). Non-resumable by construction; every failure is a retryable error, never suspended.

- [#207](https://github.com/manyfold-open/manyfold/pull/207) [`575b309`](https://github.com/manyfold-open/manyfold/commit/575b3094d06e2f1f585324668f89ad8ef9d13c1a) Thanks [@yingca1](https://github.com/yingca1)! - Add per-message model switching for openclaw agents in the chat composer, matching hermes. The model list comes from the agent's provider-models cache (openclaw joins the model-config provider-detail allowlist), and the pick is applied to the openclaw ACP turn via an in-box `openclaw gateway call sessions.patch {model}` in the exec wrapper — probe-verified to change a live session's model from the next prompt, stick to the gateway session key, and route through to the provider even for models not pre-registered in the gateway config (so no catalog registration is needed). Behind `MF_OPENCLAW_ACP`; narranexus is unaffected.

- [#207](https://github.com/manyfold-open/manyfold/pull/207) [`575b309`](https://github.com/manyfold-open/manyfold/commit/575b3094d06e2f1f585324668f89ad8ef9d13c1a) Thanks [@yingca1](https://github.com/yingca1)! - Add an openclaw permission mode (`default` / `dontAsk`, default `dontAsk`) to the chat API. `dontAsk` is exactly today's behaviour — the gateway ships `tools.exec.ask` off, so a turn that sends no mode sets nothing and never prompts. `default` turns exec approval on for the ACP turn: the adapter pre-patches the session's `execAsk` over the loopback gateway (`openclaw gateway call sessions.patch`, verified to upsert the deterministic session key and apply from the first turn), sets the ACP client to interactive, and registers with the shared permission coordinator, so `session/request_permission` relays to the chat as an interactive card answerable through the existing endpoint. Wired through the create-message DTO, ChatService, and the adapter; the openclaw ACP path is still behind `MF_OPENCLAW_ACP`.

### Patch Changes

- [#207](https://github.com/manyfold-open/manyfold/pull/207) [`575b309`](https://github.com/manyfold-open/manyfold/commit/575b3094d06e2f1f585324668f89ad8ef9d13c1a) Thanks [@yingca1](https://github.com/yingca1)! - Lift the framework-neutral ACP decoders (event mapping, permission-request decode, session-state decode, model matching, stderr classifiers, auto-approve / reject option pickers) into `@manyfold/shared` so the API-side and daemon-side ACP clients share one copy, and introduce an `AcpDialect` seam (error prefix, log tag, legacy auto-approve id, optional session/prompt `_meta`) so a second framework plugs into the same client. The API ACP client class is now `AcpTurn` (dialect-taking), with `HermesAcpTurn` kept as an alias. Pure internal refactor with no behaviour change: a live turn and a replayed turn decode through exactly one implementation, and hermes keeps its byte-identical error strings and defaults.

## 0.69.0

### Minor Changes

- [#200](https://github.com/manyfold-open/manyfold/pull/200) [`39d4d34`](https://github.com/manyfold-open/manyfold/commit/39d4d349cc41c7c48faa2b9619990cbb15d7e124) Thanks [@yingca1](https://github.com/yingca1)! - The chat sidebar now shows new chats as they appear, without a reload. Until
  now the session list under each agent was fetched once per page load, so a chat
  started anywhere other than the current browser tab stayed invisible — a Slack,
  Discord, Telegram, Lark or GitHub thread reaching your agent, a scheduled
  automation, or a call to the A2A or OpenAI-compatible API. Those chats now
  arrive in the sidebar within about a second, and pick up their title as soon as
  it is derived from the first message.

## 0.68.0

### Minor Changes

- [#199](https://github.com/manyfold-open/manyfold/pull/199) [`2a51fa7`](https://github.com/manyfold-open/manyfold/commit/2a51fa740de47ca8284503772dc62f7d7a69d1b4) Thanks [@yingca1](https://github.com/yingca1)! - Add a Google Chat channel provider. Connect a Google Chat app to an agent to reach it from direct messages and spaces in Google Workspace: mention gating, one session per thread with replies nested under the message that started them, space and user allowlists with operator rights, inbound file downloads, and native slash commands.

    Google signs inbound requests with a JWT rather than an HMAC, so the channel verifies it against Google's key set in either audience mode the Chat API console offers — the endpoint URL (captured for you by Register) or the Cloud project number.

    Chat allows only one write per second in each space, shared with every other Chat app there, so this provider defaults its reply mode to Final and paces long replies. Live progress is available per channel. Sending files is not supported: uploading to Chat requires user authorization that an app cannot hold.

    `mf channels create --provider` lists the new provider.

## 0.67.1

### Patch Changes

- [#192](https://github.com/manyfold-open/manyfold/pull/192) [`ee7fae1`](https://github.com/manyfold-open/manyfold/commit/ee7fae1de098e6cc8433591f8cc802f4c05ed8b7) Thanks [@yingca1](https://github.com/yingca1)! - Stop sprite-runner sandboxes from minting a phantom duplicate agent, and remove the runner host when its sandbox is deleted. A sandbox VM runs a platform daemon (a "sprite-runner") to dispatch coding-agent turns; it was registering a daemon runtime for every framework it detected — including openclaw/hermes, whose real runtime is the sandbox one — and reconcile then adopted the framework's built-in `main`/`default` profile on it as a second, undeletable agent that the runtimes list hides. A sprite-runner now carries coding-framework runtimes only. Separately, the runner host hangs off `daemon_id` (not the sandbox's `host_id`), so deleting or reaping the sandbox left it and its runtimes stranded; sandbox teardown now removes the runner together with the VM.

## 0.67.0

### Minor Changes

- [#188](https://github.com/manyfold-open/manyfold/pull/188) [`832cd55`](https://github.com/manyfold-open/manyfold/commit/832cd5569a38397c17a2e4602428d4bf89af88e0) Thanks [@yingca1](https://github.com/yingca1)! - Codex agents can now run GPT-6 Astra. It joins the model catalog at the head of the default preference scan (Astra → GPT-5.6 Sol → Terra → Luna → GPT-5.5 → …), matching the priority order Codex 0.153.4 ships, so a provider that serves Astra now defaults new agents to it while providers without it keep resolving as before. The `max` and `ultra` reasoning levels move from unexposed to selectable, gated per model — Astra, Sol and Terra reach `ultra`, Luna stops at `max`, GPT-5.5 and older stay at `xhigh`. GPT-5.3 Codex is deactivated in the catalog: it no longer exists in the upstream Codex model list.

### Patch Changes

- [#187](https://github.com/manyfold-open/manyfold/pull/187) [`2c45a5e`](https://github.com/manyfold-open/manyfold/commit/2c45a5e9b473d854672923826a82f71783698c07) Thanks [@yingca1](https://github.com/yingca1)! - Fix newly created OpenClaw sprite agents answering every request with `proxy_attribution_required`. OpenClaw 2026.8.1 and later attribute proxy-shaped traffic to a client IP before gateway auth and reject what they cannot attribute, so the loopback-only `trustedProxies` we wrote into `openclaw.json` made the sprite platform's own ingress untrusted — the agent's chat endpoint and its Control UI both returned 403 before the gateway token was ever read.

## 0.66.0

### Minor Changes

- [#176](https://github.com/manyfold-open/manyfold/pull/176) [`5e61a09`](https://github.com/manyfold-open/manyfold/commit/5e61a092ffbdab0508c917b8323786b2246affa3) Thanks [@yingca1](https://github.com/yingca1)! - Show each turn's prompt and result on the admin chat-session page.

    The page had three cards — Session, Turns, Events — and none of them showed a
    line of message body. The Turns table identified a turn by a bare UUID, so the
    first question anyone opens the page with ("what did the user ask, and what did
    the agent answer?") could only be answered by reading `token` event payloads
    back one row at a time, and only for as long as those rows exist.

    A Transcript card now sits between Turns and Events, pairing each assistant
    turn with what was sent to produce it, newest first, 20 turns to a page. Each
    entry carries the same figures as the table row above it — state, model,
    tokens, cost, TTFT, duration — plus a `Trace events` button that drives the
    Events card's existing per-turn filter, so one click gets you the prompt, the
    answer and the event trace for the same turn.

    It reads `chat_messages.content_blocks_json`, which outlives the event log:
    stream-log compaction deletes a turn's token and thinking rows, so for a
    compacted turn these blocks are the only surviving copy of what it produced.
    The card says so.

    The result renders as the answer text the user saw, with `thinking`,
    `tool_call` and `tool_result` blocks folded behind a toggle that names what it
    holds (`1 thinking block · 2 tool calls · 2 tool results`) — a coding turn with
    forty tool calls would otherwise bury the answer it is supposed to show. An
    unrecognised block kind keeps its raw type and renders as JSON rather than
    being dropped: the column is jsonb, and a row recovered from a runtime session
    file is not this build's to assume.

    Three states that used to be indistinguishable now say which they are. A turn
    whose prompt row retention has already deleted reports that, instead of
    borrowing the previous turn's prompt or rendering blank — retention deletes
    `chat_messages` in batches, so a turn really can outlive its own prompt. A
    still-streaming turn says it is streaming rather than claiming it produced
    nothing, because the blocks are written at the terminal event. A turn that
    genuinely produced no answer text says that.

    `GET /admin/chat-sessions/:id/turns?limit=&before=` is the new endpoint behind
    it, keyset-paged on `(created_at, id)` like the share transcript it mirrors.
    Content stays off `GET /admin/chat-sessions/:id`, whose response already
    carries up to 100 turns and would grow by tens of kilobytes each. A turn's
    input is the messages between the previous assistant message and this one —
    normally one user message, but a recovered transcript can carry a system
    preamble and more than one prompt, and they arrive in the order the agent
    received them.

## 0.65.0

### Minor Changes

- [#169](https://github.com/manyfold-open/manyfold/pull/169) [`6671c65`](https://github.com/manyfold-open/manyfold/commit/6671c65615b7aec5f064a6a47d4ace41c077f089) Thanks [@yingca1](https://github.com/yingca1)! - The Agent sessions panel loads progressively and stays fast with many sessions. Cloud sessions show at once — each with its title, newest reply and model straight from the database — while the runtime is scanned in the background; reopening the panel shows the last list immediately and refreshes it, and "Show more" reaches runtime sessions older than the newest 25. The panel no longer closes when you switch sessions, only when you switch agents.

    On the runtime, the scan now takes one index of every transcript and reads only the files that changed since the last scan, instead of forking a process per file and re-reading the newest fifty every time; Claude Code subagent transcripts, which duplicated their parent session, are left out. The `runtime-sessions/list` API accepts `local: 'skip'` and `localLimit`, and reports `localTotal` / `localListed` with `localScan: 'skipped'` when the runtime was not asked.

## 0.64.0

### Minor Changes

- [#159](https://github.com/manyfold-open/manyfold/pull/159) [`b8108e9`](https://github.com/manyfold-open/manyfold/commit/b8108e9bdc2ac76513b3d405192e98ffdba32309) Thanks [@yingca1](https://github.com/yingca1)! - The chat's right-hand runtime session panel becomes **Agent sessions**, and it
  opens on a list of every conversation the agent has instead of dropping you into
  one transcript.

    The list is the union of both places a session can live. The cloud database
    holds the conversations you started in the web app; the framework's own CLI
    leaves transcripts on the runtime. They are joined on the runtime's session id,
    so a conversation that exists on both sides is one row, and each row says which
    sides it is on, whether it is the conversation currently open, how many messages
    it holds, when it was last active, the model that wrote the newest reply and
    what that reply said. A row we never read on the runtime stays silent about
    replies rather than claiming there were none.

    An unreachable runtime no longer fails the whole panel. A stopped sandbox or an
    offline daemon now degrades to the cloud half of the list and says the local
    side is unknown, instead of returning a service error.

    Each row carries a menu to copy the framework's resume command, the session id
    and the transcript's file path, refused with a reason where the row has no
    runtime transcript or the framework's CLI cannot be pointed at a session by id.
    The copied command is deliberately the plain `claude --resume <id>` /
    `codex resume <id>` form: the terminal's own resume adds a permission-bypass
    flag because it is entering a runtime that is already the trust boundary, and a
    command on your clipboard runs wherever you paste it.

    Opening the panel used to read a whole transcript before it could show anything.
    The list is now its own endpoint, `POST /agents/:id/runtime-sessions/list`, which
    runs one bounded scan and reads no transcript; opening a named session skips the
    scan the caller already paid for. That scan now also reads the last 64 KiB of any
    transcript past its head window, because the newest reply, its timestamp and its
    model are at the end of the file. Frameworks whose transcripts record no model —
    OpenClaw and Hermes — leave that field empty rather than showing a guess.

    Two smaller things in the same panel. Arriving at a chat no longer opens the
    Files panel for you — it used to open itself on first entry to any agent with a
    workspace, taking the side of the screen before you asked for anything. And
    below the large breakpoint the panel now covers the screen instead of sharing
    the height with the conversation, which left both halves too short to use on a
    phone.

## 0.63.0

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

- [#143](https://github.com/manyfold-open/manyfold/pull/143) [`d33315f`](https://github.com/manyfold-open/manyfold/commit/d33315f21fc026403638529d45e0aec7553ead08) Thanks [@yingca1](https://github.com/yingca1)! - Messages you write in the resumed terminal TUI now appear back in the chat
  view. The TUI writes only to the framework CLI's own transcript, which the
  cloud chat never read, so continuing a conversation there used to vanish from
  the structured view. The chat now folds that transcript's additions back into
  the session — on switching back from the terminal, and on opening the session —
  by diffing the CLI's file against the stored messages and appending only what
  is new. Idempotent and skipped while a live turn is running, so it is safe to
  run automatically. Claude Code and Codex; the API endpoint is
  `POST /agents/:id/runtime-sessions/sync`.

### Patch Changes

- [#147](https://github.com/manyfold-open/manyfold/pull/147) [`f704917`](https://github.com/manyfold-open/manyfold/commit/f704917ad0ddd3e1d3c3f99c617f4a509161676f) Thanks [@yingca1](https://github.com/yingca1)! - Active-hours enforcement now holds on a sandbox that is already awake, and says
  so when it cannot.

    Turns on a running sandbox were admitted through a fast path that skipped the
    hours check, on the reasoning that the background sweep would put an over-quota
    sandbox to sleep and the next cold start would re-check everything. When the
    sweep cannot reach whatever is keeping a sandbox awake that never happens, so an
    over-quota sandbox kept accepting work indefinitely — on production, ten times
    its included hours. Over-quota users are now refused on that path too, with the
    same message and the same relief (a plan change or an hours bonus unblocks them
    immediately). Users within their quota see no change, and installations with
    enforcement turned off are unaffected.

    Stopping a sandbox also no longer reports a clean result when it had nothing it
    could act on. A running sandbox with no agents, runtimes, services or tasks
    registered on it is being held awake by something out of reach, so the stop
    cannot work; that now comes back as a warning, is recorded on the audit entry,
    and is logged. The enforcement sweep reports those hosts separately from the
    ones it actually put to sleep, so a sandbox it is powerless to stop shows up the
    first time instead of after days of apparently successful retries.

- [#143](https://github.com/manyfold-open/manyfold/pull/143) [`d33315f`](https://github.com/manyfold-open/manyfold/commit/d33315f21fc026403638529d45e0aec7553ead08) Thanks [@yingca1](https://github.com/yingca1)! - Fixes for folding a resumed TUI's messages back into the chat. Appended
  messages now carry their `done` terminal in the same transaction (all recovery
  writers), so a page reload no longer mistakes a synced turn for a dead inflight
  one and stamps `server_restart` over it. The append is idempotent by
  `source_event_key`, so repeated Chat↔TUI switches can no longer duplicate
  messages, and a TUI turn that is still streaming is left for the next sync
  instead of being frozen as an empty bubble. The session terminal now follows
  the sidebar's session switch, resuming the newly selected session — and the
  sync runs the other way too: messages sent from the chat after the TUI was
  opened rebuild it on the next switch, so the resumed TUI always shows the
  whole conversation.

- [#145](https://github.com/manyfold-open/manyfold/pull/145) [`4263614`](https://github.com/manyfold-open/manyfold/commit/4263614d876d52f9c5290fe25fe1fa7b6b451933) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox no longer stays awake — and no longer bills active hours — because of
  an exec session nobody is attached to. sprites.dev keeps a session's process
  running after its client socket goes away, so an upload or command that died
  mid-stream could leave a process blocked forever, and a live exec session pins
  the VM `running`. On production this let one free-plan sandbox accrue 52 hours
  against a 5-hour quota over three days: the sandbox had no agents, runtimes,
  services or tasks left, so the active-hours enforcement sweep found nothing to
  stop and reported success on every pass.

    Two changes: a command that ends on the client's terms (timeout, cancellation,
    or a request body that failed part-way) now terminates its remote session
    instead of only closing the connection, and the sandbox sync loop reaps
    sessions on running sandboxes that nothing has touched for six hours — well
    clear of the longest permitted chat turn. Reaped sessions are logged and
    counted so a sandbox that cannot be put back to sleep is visible instead of
    quietly accruing.

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
