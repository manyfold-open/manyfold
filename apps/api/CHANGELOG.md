# @manyfold/api

## 10.11.0

### Minor Changes

- [#706](https://github.com/manyfold-open/manyfold/pull/706) [`0057559`](https://github.com/manyfold-open/manyfold/commit/00575590e739da0b494c6e81f8e87f230df8aeef) Thanks [@yingca1](https://github.com/yingca1)! - Only a machine that fails to start puts a sandbox into maintenance. On staging, every sleeping sprite answered the provider's health check with `needs_repair` ("machine in suspended state"), and a stopped one answered `repaired` after the check restarted it. Counting anything but `healthy` as a problem therefore sent idle sandboxes into a maintenance they could not leave: nothing wakes a sandbox in maintenance, and a sleeping machine never answers `healthy`.

    - Now only `unhealthy` ("failed to start machine") puts a sandbox in maintenance or keeps it there.
    - `healthy`, `needs_repair` and `repaired` bring a sandbox out, and an unrecognised status changes nothing.
    - Admin › Sandboxes shows `needs_repair` and `repaired` in neutral.

## 10.10.0

### Minor Changes

- [#696](https://github.com/manyfold-open/manyfold/pull/696) [`fde1962`](https://github.com/manyfold-open/manyfold/commit/fde19627f4494b2cf4d0aa011f23dbf0201ebc9c) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox stays awake while a turn handed to another API instance finishes. When an instance handed a live turn on and then held the same sandbox again (the daemon reconnecting to it while it drained), letting go of that later hold deleted the handed-off turn's keep-awake task and the sandbox could go to sleep under the turn. A handed-off task now lapses only by its TTL, and later holds on that machine use their own task.

- [#696](https://github.com/manyfold-open/manyfold/pull/696) [`fde1962`](https://github.com/manyfold-open/manyfold/commit/fde19627f4494b2cf4d0aa011f23dbf0201ebc9c) Thanks [@yingca1](https://github.com/yingca1)! - The mf CLI version list ("Change version…" on a sandbox, and the versions the update flows offer) lists every stable release again. When GitHub refuses the platform's token for the public releases repository, through an organization token policy or an invalid token, the API now reads the list without the token instead of falling back to the latest version alone.

- [#696](https://github.com/manyfold-open/manyfold/pull/696) [`fde1962`](https://github.com/manyfold-open/manyfold/commit/fde19627f4494b2cf4d0aa011f23dbf0201ebc9c) Thanks [@yingca1](https://github.com/yingca1)! - A framework install on a sandbox or cloud computer no longer ends with a broken CLI when the machine's connection drops while it runs. The platform now follows the running install across every reconnect instead of giving up after the first, and it never retries an install whose machine stopped answering alongside the one still running. On the machine, installs of one framework run one at a time, the cleanup after an install only removes installs it superseded (never one still extracting or the one PATH points into), and an install whose package arrives without its own manifest is rejected before it reaches PATH, for a latest install as well as an exact one.

- [#696](https://github.com/manyfold-open/manyfold/pull/696) [`fde1962`](https://github.com/manyfold-open/manyfold/commit/fde19627f4494b2cf4d0aa011f23dbf0201ebc9c) Thanks [@yingca1](https://github.com/yingca1)! - A Hermes turn handed to another API instance mid-run (a deploy or restart) now resumes to its real answer. The resume replays the daemon's output from the start, and its first already-stored row used to stop the relay and mark the turn finished with empty content while it was still running; the real answer, with its usage, was then dropped. Hermes now declares that replay, so stored rows are matched rather than written again, and a replayed permission ask is matched the same way. Any resume that stops on a write it cannot land now leaves the turn open for its real final instead of declaring it done.

- [#697](https://github.com/manyfold-open/manyfold/pull/697) [`2e08e83`](https://github.com/manyfold-open/manyfold/commit/2e08e83221a6331a5f4a818ddeeff206988e9723) Thanks [@yingca1](https://github.com/yingca1)! - Hosted sandboxes have a health check and a maintenance stage. When the sandbox provider's own health check reports a sandbox's machine broken, the sandbox goes into maintenance. Chat turns and A2A tasks on its agents end at once with `sandbox_maintenance`, and automation runs fail at once saying why, instead of spending minutes on wake retries. Nothing wakes the machine: requests that would take an active sandbox slot for it answer 409 `SANDBOX_MAINTENANCE`. It is checked again on a backoff — 2 minutes, 10, 30, then hourly — and returns to ready as soon as a check comes back healthy.

    - Admin › Sandboxes shows each sandbox's last verdict with a Check now button (`POST /api/admin/sandboxes/:id/health-check`). A sandbox in maintenance shows how long it has been there and when it is checked next, and offers End maintenance (`POST /api/admin/sandboxes/:id/maintenance/end`). Both are audited.
    - Three switches under Admin › Feature toggles, all off by default: a check after a sandbox fails to wake (`sandbox_health_checks`), automatic entry into maintenance (`sandbox_maintenance_auto`; while it is off, verdicts are only recorded), and a daily sweep of sandboxes no daemon has proven alive (`sandbox_health_sweep`). An admin's own check always applies its verdict, and automatic entries are capped per hour.
    - The web shows the status wherever a sandbox's state appears, blocks the composer with the reason, and explains a refused turn.
    - `runtime_hosts` gains the health-check columns (migration 0034). `SandboxSummary` gains `health` and `maintenanceSince`, and the host status and agent availability gain `maintenance`.

## 10.9.0

### Minor Changes

- [#687](https://github.com/manyfold-open/manyfold/pull/687) [`e9e514f`](https://github.com/manyfold-open/manyfold/commit/e9e514f05dd1a3ed9da17539f68c8eb5a3dbada8) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - The workspace rail shows whether your own coding agent is connected to Manyfold. A chip beside the concurrency meter reads Connect agent, Connected, or In use (a request in the last 90 seconds); clicking it opens the setup prompt, or a panel with the last request, Connect another agent, Manage sign-ins and Disconnect. The setup dialog now walks through copying the prompt, approving the sign-in and connecting, and confirms on its own once the agent has signed in. Tokens minted by `mf login` are now recorded with `createdVia: 'cli-browser'`, so they can be told apart from tokens made by hand.

- [#692](https://github.com/manyfold-open/manyfold/pull/692) [`5be08f8`](https://github.com/manyfold-open/manyfold/commit/5be08f8998689cd3de8e17803abc8aa6c6111d1b) Thanks [@yingca1](https://github.com/yingca1)! - OpenClaw agents start again on OpenClaw 2026.9.8 and later. The gateway config Manyfold writes no longer sets `gateway.controlUi.allowInsecureAuth`, a key OpenClaw retired in 2026.8 and that 2026.9.8 refuses at startup ("Unrecognized key", exit 78), which made every new OpenClaw agent on the latest release fail while starting its service and would have broken an existing one upgraded to it. A restart rewrites an existing agent's config without the key. The Control UI is unaffected: it is let in by `dangerouslyDisableDeviceAuth`, which stays.

### Patch Changes

- [#672](https://github.com/manyfold-open/manyfold/pull/672) [`6998e1b`](https://github.com/manyfold-open/manyfold/commit/6998e1b1485f178987c71bd21b42888352ecda3b) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Approving a CLI sign-in from your phone no longer stalls it. When an agent runs `mf login` on a computer and you approve from your phone (steering a Codex or Claude Code session remotely), the consent page used to redirect the phone to `127.0.0.1`, which reaches nothing, and the agent waited out the full 15 minutes before asking you to approve a second time. On a phone the page now shows the one-time `mf_auth_` code to send back instead. On a computer it still finishes on its own, and a "Not on the computer running mf?" link gets you the code when you approve from another machine. The agent setup guide (`GET /api/agent-setup.md`) tells the agent to stop waiting and redeem a code you send back with `mf login --auth-code`, which every installed `mf` already supports.

## 10.8.0

### Minor Changes

- [#688](https://github.com/manyfold-open/manyfold/pull/688) [`4a3723d`](https://github.com/manyfold-open/manyfold/commit/4a3723dd0f01e8a66f9f5c37043daae50abb41d8) Thanks [@yingca1](https://github.com/yingca1)! - A dropped database connection no longer takes the API process down through work that nothing waits on. Several background jobs started a database call without awaiting it: the sandbox power-sync tick, which runs every 1.5 seconds, the automation scheduler, the export and deletion sweeps, a forced daemon disconnect, the sign-in reconcile after a terminal closes, the ready-service refresh and the pod-host cleanup. When the pooler dropped connections, the call rejected with nobody to handle it, and the API exits on an unhandled rejection. Those jobs now log the failure and keep running. As a backstop, an unhandled rejection that postgres.js raised for a lost connection (`CONNECTION_CLOSED`, `CONNECTION_ENDED`, `CONNECTION_DESTROYED` or `CONNECT_TIMEOUT`) is reported as a `process.unhandled_rejection` event with `outcome: recovered` instead of ending the process; every other unhandled rejection is still fatal.

- [#688](https://github.com/manyfold-open/manyfold/pull/688) [`4a3723d`](https://github.com/manyfold-open/manyfold/commit/4a3723dd0f01e8a66f9f5c37043daae50abb41d8) Thanks [@yingca1](https://github.com/yingca1)! - Every closed database connection now emits a `db.connection.closed` event naming its pool (`app`, `bus` or `broker`). Lifetime recycling shows up as an occasional single event. A pooler or network drop shows up as a burst across pools and machines at the same second, so it can be told apart from a single connection. The daemon RPC broker's connections now identify themselves as `mf-api-broker` in `pg_stat_activity` instead of the driver default `postgres.js`.

- [#688](https://github.com/manyfold-open/manyfold/pull/688) [`4a3723d`](https://github.com/manyfold-open/manyfold/commit/4a3723dd0f01e8a66f9f5c37043daae50abb41d8) Thanks [@yingca1](https://github.com/yingca1)! - Claude Code turns now freeze the provider route they were dispatched on, the way Codex, Gemini CLI, pi and Antigravity CLI turns already do. A resumed run whose CLI reports the session's running total is priced from its own tokens under that verified provider and managed brand, including after an API restart re-attaches to it, instead of under no brand at all. Usage is attributed to a provider only when the turn carried that provider's key to its endpoint; a run on the CLI's own sign-in is no longer attributed to the Agent's saved provider.

- [#688](https://github.com/manyfold-open/manyfold/pull/688) [`4a3723d`](https://github.com/manyfold-open/manyfold/commit/4a3723dd0f01e8a66f9f5c37043daae50abb41d8) Thanks [@yingca1](https://github.com/yingca1)! - OpenClaw and Hermes turns are no longer priced from the provider the Agent happens to be bound to. Their runtime picks the provider from its own config, so the API now sends each turn a fresh challenge and prices the turn by the provider row the daemon proves served it, including that row's managed brand and any price an operator set on it. A turn whose daemon cannot prove its route — an older CLI, a runtime config Manyfold did not write, a provider switched mid-turn — is recorded with no provider and priced from the public tables, and the API logs why. What the API expected is stored with the turn, so a turn recovered after an API restart is checked against the binding it was dispatched with.

- [#688](https://github.com/manyfold-open/manyfold/pull/688) [`4a3723d`](https://github.com/manyfold-open/manyfold/commit/4a3723dd0f01e8a66f9f5c37043daae50abb41d8) Thanks [@yingca1](https://github.com/yingca1)! - A skill repository whose catalog scan fails is not scanned again until a backoff ends, and every API instance honours it. The wait is at least a minute and doubles while failures continue, up to an hour; when GitHub rate-limits the scan, it also lasts at least until its `Retry-After` or, with no requests left, its `x-ratelimit-reset`. Before, a failed scan left nothing behind, so each catalog page view started the same scan again: during one rate-limit window, 18 scans in three and a half minutes spent over 2,000 GitHub requests. Inside the backoff the catalog still lists the skills from the last good scan. A skill install or catalog refresh that needs the repository answers 503 `github_source_unavailable` with a `Retry-After` header, instead of sending a request GitHub would refuse. A skill import that fails at GitHub, or while saving, now logs its stage and failure classification.

- [#688](https://github.com/manyfold-open/manyfold/pull/688) [`4a3723d`](https://github.com/manyfold-open/manyfold/commit/4a3723dd0f01e8a66f9f5c37043daae50abb41d8) Thanks [@yingca1](https://github.com/yingca1)! - Report an international WeChat channel as connected while its long polls end at the edge timeout, instead of leaving it in error and restarting it every 10 minutes. A getupdates HTTP 554 is now the same poll boundary as 524, and an edge connect timeout (HTTP 522/552) is retried in the poll loop; only three in a row put the channel in error.

- [#688](https://github.com/manyfold-open/manyfold/pull/688) [`4a3723d`](https://github.com/manyfold-open/manyfold/commit/4a3723dd0f01e8a66f9f5c37043daae50abb41d8) Thanks [@yingca1](https://github.com/yingca1)! - A re-scanned WeChat channel reconnects right away instead of waiting out the rest of the hour-long pause its expired session started, and a successful Register ends that pause too. While a session stays expired, restarting the channel no longer sends the gateway a stop request with the dead token.

- [#688](https://github.com/manyfold-open/manyfold/pull/688) [`4a3723d`](https://github.com/manyfold-open/manyfold/commit/4a3723dd0f01e8a66f9f5c37043daae50abb41d8) Thanks [@yingca1](https://github.com/yingca1)! - Pasting a new bot token into a WeChat channel keeps the gateway the bot was registered on. Before, an international channel updated from its settings, or with only a `botToken` from the CLI, moved to the default domestic gateway. A gateway named explicitly in the update still replaces the stored one.

### Patch Changes

- [#688](https://github.com/manyfold-open/manyfold/pull/688) [`4a3723d`](https://github.com/manyfold-open/manyfold/commit/4a3723dd0f01e8a66f9f5c37043daae50abb41d8) Thanks [@yingca1](https://github.com/yingca1)! - An external-agent turn (Dify, Langflow, A2A) cancelled while its upstream task reference was being saved no longer ends the API process when that save then finds another instance owns the turn. The late failure is dropped, because nothing is waiting on a cancelled turn's reference write.

- [#688](https://github.com/manyfold-open/manyfold/pull/688) [`4a3723d`](https://github.com/manyfold-open/manyfold/commit/4a3723dd0f01e8a66f9f5c37043daae50abb41d8) Thanks [@yingca1](https://github.com/yingca1)! - A Postgres connection that closes while a transaction is using it no longer crashes the API. Before, the automatic rollback was written to the closed socket and threw an uncaught `TypeError`. Queries still queued in that transaction stayed pending forever. A transaction callback that kept running could also query, commit or roll back whichever transaction reused the connection next. The bundled postgres.js 3.4.9 is now patched with the upstream fix ([porsager/postgres#1215](https://github.com/porsager/postgres/pull/1215)): the transaction's own queries, including its rollback or commit, reject with `CONNECTION_CLOSED`, and the reconnected connection starts clean.

## 10.7.0

### Minor Changes

- [#678](https://github.com/manyfold-open/manyfold/pull/678) [`b2d915d`](https://github.com/manyfold-open/manyfold/commit/b2d915d2681533d73a78275dad1c39bc02d169e9) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox agent whose workspace sits outside its daemon's own workspace tree, such as one created under the older `~/.nca/workspaces`, gets its context file and its project MCP servers again. Configuration is written through the daemon's protected file calls, which refuse a folder the daemon does not know, so every delivery to such an agent failed on each reconnect while its turns still ran. On a hosted machine the platform now vouches for the agent's workspace on each configuration read and write, as the files view already does. A self-owned computer still accepts only the folders its own daemon registered.

### Patch Changes

- [#678](https://github.com/manyfold-open/manyfold/pull/678) [`b2d915d`](https://github.com/manyfold-open/manyfold/commit/b2d915d2681533d73a78275dad1c39bc02d169e9) Thanks [@yingca1](https://github.com/yingca1)! - A configuration write that fails on a machine now logs which host and agent it was for and why, in fixed words: `outside_allowed_roots`, `timeout`, `offline`, a `config_commit_*` code, or the error's class. This covers both the context file and each MCP scope. Before, the warning said only that a write had failed, and the daemon's own reason was dropped.

## 10.6.0

### Minor Changes

- [#448](https://github.com/manyfold-open/manyfold/pull/448) [`e671dc0`](https://github.com/manyfold-open/manyfold/commit/e671dc09d31eff04fc599f0c5e5f9693fcc61cd9) Thanks [@yingca1](https://github.com/yingca1)! - Log records exported over OTLP keep the attribute columns the receiver already has, and every other attribute (new names and nested values) goes into the `attributes.custom` map with its type intact. New telemetry fields no longer add receiver columns, so a receiver at its field limit stops rejecting whole log batches, ordinary and process-exit logs included. Query those attributes as `['attributes.custom']['<name>']`. The dataset must hold `attributes.custom` as a map field: Axiom creates it when the first span with a custom attribute arrives; on a new dataset, create it before enabling export.

## 10.5.0

### Minor Changes

- [#664](https://github.com/manyfold-open/manyfold/pull/664) [`7bfb110`](https://github.com/manyfold-open/manyfold/commit/7bfb110788c92a830793c14fcc860ee3358e7bec) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox or cloud computer created before 8.0.0 gets its agents' MCP servers again when its daemon reconnects, and importing MCP servers from it works. The 8.0.0 upgrade that merged each machine's runner into the machine left the machine without a home directory. Since then, the automatic delivery after every reconnect failed for every MCP scope, with nothing in the logs, and an import answered `agent runtime home dir is unknown`. A migration restores the home directory the machine's image runs under (`/home/sprite` on a sandbox, `/home/node` on a cloud computer). The workspace and skill roots are left as they were, because only the machine's own registration can declare them.

### Patch Changes

- [#664](https://github.com/manyfold-open/manyfold/pull/664) [`7bfb110`](https://github.com/manyfold-open/manyfold/commit/7bfb110788c92a830793c14fcc860ee3358e7bec) Thanks [@yingca1](https://github.com/yingca1)! - `daemon_config_reconcile` now says which host it ran for (`hostId`), how many agents failed (`failed`) and why the first one failed (`reason`, the delivery's own wording or the error's class). Before, a run that kept failing recorded only `outcome: failed`. All three names already exist in the log store.

## 10.4.0

### Minor Changes

- [#657](https://github.com/manyfold-open/manyfold/pull/657) [`43563ec`](https://github.com/manyfold-open/manyfold/commit/43563ec6eb1a806ca151e1293d2772cced3ae550) Thanks [@yingca1](https://github.com/yingca1)! - A turn that wakes a sandbox from cold now gives its runner up to 90 seconds to boot and dial back in. Before, it waited 15 seconds and then tried to restart the runner while the machine was still booting. That could fail the turn with "not accepting commands" seconds before the runner came back.

- [#657](https://github.com/manyfold-open/manyfold/pull/657) [`43563ec`](https://github.com/manyfold-open/manyfold/commit/43563ec6eb1a806ca151e1293d2772cced3ae550) Thanks [@yingca1](https://github.com/yingca1)! - Monthly plan allowances (sandbox active hours, API requests, automation runs and model spend) now reset every month on subscriptions billed over a longer term, such as annual plans. Until now the whole term was a single usage window, so an allowance used up in one month stayed used up until the term ended. Subscriptions billed monthly are unchanged.

## 10.3.1

### Patch Changes

- [#653](https://github.com/manyfold-open/manyfold/pull/653) [`25e0d6c`](https://github.com/manyfold-open/manyfold/commit/25e0d6c2791aa16c90bd67435d1d2251224039b5) Thanks [@yingca1](https://github.com/yingca1)! - The A2A turn events no longer bring attribute names the log store does not have, which made it refuse every batch that carried one. `a2a.turn.complete`, `a2a.turn.timeout` and `a2a.turn.error` drop `handedOver` (`a2a.turn.handover` records the handover by `taskId`), and `a2a.turn.handover` reports the cap it reached as `timeoutMs` instead of `blockingMs`, `asyncMs` and `remainingMs`.

- [#653](https://github.com/manyfold-open/manyfold/pull/653) [`25e0d6c`](https://github.com/manyfold-open/manyfold/commit/25e0d6c2791aa16c90bd67435d1d2251224039b5) Thanks [@yingca1](https://github.com/yingca1)! - The runner and sandbox-probe events added in the previous release no longer bring new attribute names to the log store, which is at its column limit and refused every batch that carried one. `chat.runner.resolve` reports its attempt as `attempts`, and `sprite_exec.probe` no longer sends `cold` (its `leaseMs` already tells a cold probe from a warm one). Chat-turn logs and traces reach the log store again.

## 10.3.0

### Minor Changes

- [#649](https://github.com/manyfold-open/manyfold/pull/649) [`777b6dd`](https://github.com/manyfold-open/manyfold/commit/777b6ddfe70db4837c6c002c508587a73a7c0347) Thanks [@yingca1](https://github.com/yingca1)! - With the A2A blocking and async caps saved equal, a send that reaches the blocking cap now always fails its task right there, as intended. Before, a busy server could read the clock a few milliseconds short of the cap, answer `working` and hand the task over, and then fail it moments later.

- [#649](https://github.com/manyfold-open/manyfold/pull/649) [`777b6dd`](https://github.com/manyfold-open/manyfold/commit/777b6ddfe70db4837c6c002c508587a73a7c0347) Thanks [@yingca1](https://github.com/yingca1)! - An automation run now checks the agent's machine before it starts. If the agent's computer is offline, or its runtime is not ready, the run fails straight away with `agent is offline` or `agent is unavailable`: no chat session is opened and no prompt is sent, and a run started by hand answers `400` with that reason. Before, this check never ran. The run opened a chat, sent the prompt and only then failed with `chat_runner_unavailable`. A sleeping sandbox is still admitted, and the run wakes it.

- [#649](https://github.com/manyfold-open/manyfold/pull/649) [`777b6dd`](https://github.com/manyfold-open/manyfold/commit/777b6ddfe70db4837c6c002c508587a73a7c0347) Thanks [@yingca1](https://github.com/yingca1)! - An automation run whose sandbox does not come up now asks again instead of failing at once: after one minute, then after three more, within the same run and chat. A cold sandbox that misses one start usually comes up minutes later, so the run still gets its reply and its one delivery. If the sandbox still does not start, the run fails as before, about eight and a half minutes in at worst, and a cancel ends it at once. Messages sent from a chat are unchanged.

- [#649](https://github.com/manyfold-open/manyfold/pull/649) [`777b6dd`](https://github.com/manyfold-open/manyfold/commit/777b6ddfe70db4837c6c002c508587a73a7c0347) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox whose commands were once refused ("not accepting commands") is no longer kept out just because it is asleep. The check that decides whether it recovered now gives a sleeping sandbox time to start, up to 45 s (`MF_SPRITE_EXEC_COLD_PROBE_TIMEOUT_MS`), instead of 5 s, which a cold start never fits in. Before, a sandbox that only scheduled runs reached stayed refused on every run: each check met it cold, timed out and refused it again.

## 10.2.0

### Minor Changes

- [#645](https://github.com/manyfold-open/manyfold/pull/645) [`5f15d84`](https://github.com/manyfold-open/manyfold/commit/5f15d84e87180879814ebe1dad22f838a2a2e3a7) Thanks [@yingca1](https://github.com/yingca1)! - An A2A turn that runs past the blocking limit keeps running instead of being stopped. A blocking `message/send` (or a `message/stream`) that reached the blocking cap, 10 minutes by default, used to cancel the agent's turn and fail the task with `turn_timeout`, however close the work was to done and even when the caller had already hung up and was polling. Now the caller gets the task back as `working` (a stream ends on a non-final `working` status update), and the same turn carries on under the async cap, 2 hours by default, which is what bounds a task now whichever way it was sent. Follow it with `tasks/get`, or reattach with `tasks/resubscribe`.

    An agent backed by a remote A2A server follows such a task to its end with `tasks/get` instead of taking the stream's early end as the answer, and forwards a cancel made while it follows.

    The admin A2A turn timeouts page describes the two caps this way.

- [#643](https://github.com/manyfold-open/manyfold/pull/643) [`5bebaee`](https://github.com/manyfold-open/manyfold/commit/5bebaee9a36bb4a1451c51cdf85f90c65d2b2a7f) Thanks [@yingca1](https://github.com/yingca1)! - The usage endpoints, the user's and the admin's, answer `400` for a query they cannot read instead of guessing. A `limit` must be a whole number of at least 1: before, `0` became 1, and `abc` returned an empty events page or the whole agent ranking. A `from`, `to` or `cursor` must be a date or timestamp such as `2026-10-01` or `2026-10-01T09:00:00Z`: before, one that did not parse was dropped and the query covered all time. A time without a zone is UTC. A limit above the maximum is still capped.

- [#642](https://github.com/manyfold-open/manyfold/pull/642) [`8acec81`](https://github.com/manyfold-open/manyfold/commit/8acec814f353cc04f04b63c5ae29e19dd79a8b42) Thanks [@yingca1](https://github.com/yingca1)! - An open chat page no longer keeps waking its sleeping sandbox. Before, each wake made the page sync the session's transcript again once the sandbox fell back asleep, and every sync woke the sandbox, so a page left open held the sandbox awake. That counted as active time, even in a hidden tab.

    The page now syncs once per opened session. `POST /api/agents/:id/runtime-sessions/sync` leaves a sandbox that is asleep, or whose daemon is not connected, untouched, and answers `skipped: 'asleep'`. Sending a message still wakes the sandbox as before.

- [#645](https://github.com/manyfold-open/manyfold/pull/645) [`5f15d84`](https://github.com/manyfold-open/manyfold/commit/5f15d84e87180879814ebe1dad22f838a2a2e3a7) Thanks [@yingca1](https://github.com/yingca1)! - A chat turn the platform stops no longer reads as the user's cancel. When an A2A task's time limit stopped the turn it started, the turn ended `cancelled_by_user`, and the chat showed a silent stop with no reason. It now ends with the error `a2a_turn_timeout` and a message naming the limit that stopped it, and counts as a failure rather than a cancel. A cancel you send yourself still ends `cancelled_by_user`.

    The chat explains a turn stopped at a time limit in plain words, keeping the technical message under it. This covers the A2A limit and the turn length limits the platform already enforced, which until now showed only their raw message.

- [#642](https://github.com/manyfold-open/manyfold/pull/642) [`8acec81`](https://github.com/manyfold-open/manyfold/commit/8acec814f353cc04f04b63c5ae29e19dd79a8b42) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox CLI update that the sandbox defers until its current sessions finish now completes. Before, the sandbox could fall asleep with the update half done. The API keeps the sandbox awake until the new CLI reports, which takes at most about 12 minutes and counts as active time.

    While the update waits, the sandbox summary carries `cliUpdateDeferred` (`activeSessions`, `deadline`). The runtimes page and `mf sandbox update` say how many active sessions the update is waiting for, instead of reporting the old version as upgraded. The Update Center keeps the row waiting until the sandbox reports another CLI. Asking again while the daemon is applying the update now waits for the new CLI instead of answering 503.

- [#645](https://github.com/manyfold-open/manyfold/pull/645) [`5f15d84`](https://github.com/manyfold-open/manyfold/commit/5f15d84e87180879814ebe1dad22f838a2a2e3a7) Thanks [@yingca1](https://github.com/yingca1)! - A deploy no longer kills the chat turns it hands off. When the shutdown drain ran out of time, the API handed each live turn off for the next instance to adopt, but that turn's own lease renewal, refused by the handoff, read as losing the turn to someone else: the turn was aborted, its sandbox process killed, and the stop recorded as the user's cancel. A refused renewal now ends the renewal only, and a turn is aborted only when its execution row has really moved to another owner, so the next instance adopts the turn and finishes it.

## 10.1.0

### Minor Changes

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - A2A messages can carry files. A `file` part (base64 `bytes`, or a public `https` `uri`) is written into the target agent's workspace the way a chat upload is, and the turn gets it as an attachment; a message may be files alone. The agent card lists the accepted types in `defaultInputModes` for agents that take files. A file of a type chat does not take, or a file sent to an agent that takes none, is refused with `-32005` before a task is created. Before, file parts were dropped and the agent saw only the text.

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - Adding an A2A peer caller that already has an active grant is now a `409` with the code `a2a_grant_exists`, and `details` names both agents, so a client can tell it apart from other conflicts. An outbound A2A request that cannot reach its endpoint (an external A2A provider) now names the endpoint in its error.

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - Channel sessions handle three edge cases correctly.

    - Deleting an inactive session with `activateFallback` no longer fails with a `500`. Only deleting the active session activates a fallback; before, a second active session broke the one-active-per-scope rule.
    - Deleting a session that is already archived keeps the time it was archived.
    - Switching to an archived session is now a `409` `channel_session_archived` with the scope in `details`, and a rename in the same request is not applied. Before, it answered `200` and changed nothing, apart from the rename. Creating a session without a `scopeKey` is now a `400`, not a `404`.

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - Browsing the web chat no longer deletes channel sessions. The chat page cleans up an empty conversation when you move on from it, and an empty conversation that a channel scope points at, for example one that `mf channels sessions new` just created, used to be deleted together with that scope's session. A non-forced delete of such a conversation is now a `409` `session_bound_to_channel`. Deleting it from the sidebar still works.

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - A managed channel mirror (a channel binding that a service framework owns, shown in Manyfold) no longer takes one of the plan's channel slots, as the channel docs already said. Creating a channel now counts only the user's own channels, and so does the channel usage and quota warning the web app shows. Before, mirrors could fill a Free plan's two slots and block every channel of the user's own.

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - Every plan limit or quota refusal (`CHANNEL_LIMIT_REACHED`, `AUTOMATION_LIMIT_REACHED`, `AUTOMATION_RUN_QUOTA_REACHED`, `ACTIVE_HOURS_QUOTA_REACHED`, `STORAGE_LIMIT_REACHED`, `CONCURRENT_ACTIVE_LIMIT_REACHED`, the always-online limits and `API_REQUEST_QUOTA_REACHED`) now carries `details` with `current`, `limit` and `planName` (and `resetAt` or `kind` where they apply), as `RUNTIME_LIMIT_REACHED` already did. Before, the numbers never reached a client, because the error envelope forwards only `details`.

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - `POST /api/v1/chat/completions` now accepts request bodies up to its intended 32 MiB (base64 file content). Before, it answered `413` above Fastify's 1 MiB default, because the limit a route declares with `@RouteConfig({ bodyLimit })` was never applied.

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - A Telegram channel test or registration that fails now mentions `PUBLIC_API_BASE_URL` only when Telegram refused the webhook URL. A missing or rejected bot token is reported on its own, without the misleading hint about a public HTTPS URL.

- [#637](https://github.com/manyfold-open/manyfold/pull/637) [`b0d54ec`](https://github.com/manyfold-open/manyfold/commit/b0d54eceaf6164f0f40741103b275c1dce388823) Thanks [@yingca1](https://github.com/yingca1)! - A pi conversation continued in the terminal comes back into chat with one message per reply, as a reply made in chat does. pi records one entry per model call, so a prompt whose tools led to several calls used to show as a run of separate answers. The runtime session list counts a reply once as well.

- [#637](https://github.com/manyfold-open/manyfold/pull/637) [`b0d54ec`](https://github.com/manyfold-open/manyfold/commit/b0d54eceaf6164f0f40741103b275c1dce388823) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox that failed to start can be retried in place, instead of being deleted and built again under a new name:

    - `POST /sandboxes/:id/retry` builds a failed sandbox again in its own row: same id and name, a new machine. It is admitted under the owner's plan like a new sandbox (a failed one holds no slot), answers 409 `SANDBOX_NOT_FAILED` for a sandbox in any other state and, like a create, 503 `SANDBOX_API_UNREACHABLE` before anything is made when no sandbox could reach this API. A build that fails again leaves the sandbox failed with the new reason.
    - Settings › Runtimes offers Retry on a failed sandbox.
    - Creating an agent: when the new sandbox built in step ② fails to start, the button retries that sandbox rather than building another. In the classic form, a failed sandbox's card offers Retry and no longer lists checks or installs for a machine that does not exist.

- [#637](https://github.com/manyfold-open/manyfold/pull/637) [`b0d54ec`](https://github.com/manyfold-open/manyfold/commit/b0d54eceaf6164f0f40741103b275c1dce388823) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox whose runner could not connect says why:

    - When a new sandbox's `mf daemon register` fails, `SANDBOX_RUNNER_NOT_CONNECTED` carries what the CLI printed, in its message and in `details.registerFailure`. That message is also the reason the failed sandbox keeps, so Settings › Runtimes shows it.
    - The web explains `SANDBOX_RUNNER_NOT_CONNECTED` and `SANDBOX_API_UNREACHABLE` in the user's language and names the address the sandbox had to reach, where it used to show the server's English text.

## 10.0.0

### Major Changes

- [#633](https://github.com/manyfold-open/manyfold/pull/633) [`5046b4c`](https://github.com/manyfold-open/manyfold/commit/5046b4c236513b9e4fda75fd4117838c7c9a6507) Thanks [@yingca1](https://github.com/yingca1)! - A runtime no longer has a primary agent. On a sandbox or a cloud computer, the agent a service framework always has — Hermes' `default` profile, OpenClaw's `main` agent — is stored under that name, so the runtime page shows the same name as the framework's own dashboard, and the reconcile knows that agent by its id like any other.

    - **Deleting agents.** The framework's own agent stays while any other agent is on its runtime; delete those first, or delete the runtime (409 `BUILT_IN_AGENT_NOT_LAST`). On a sandbox or a cloud computer, deleting a runtime's last agent tears the runtime down, with the sandbox kept for reuse. No agent is promoted in place of a deleted one.
    - **Joining a prepared runtime.** The first agent to join a service runtime prepared with no agent takes the framework's own profile on a sandbox too, as on a cloud computer.
    - **Framework versions belong to the runtime.** `POST /agent-runtimes/:id/framework-version/refresh`, `/upgrade` and `/upgrade-stream` (and their `/admin/agent-runtimes` twins) replace the `/agents/:id/framework-version/*` routes, need the `agent-runtimes:edit` scope, and return the runtime; the stream's `complete` event carries `runtime`. A runtime with no agent on it can be upgraded.
    - **API shape.** `primaryAgentId` is gone from the runtime summary, and the web and admin no longer show a primary agent or a Primary tag.
    - **Migration.** Each sandbox and cloud computer runtime's existing primary for Hermes or OpenClaw is re-keyed to `default` or `main`; the `primary_agent_id` columns are dropped.

### Minor Changes

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - Repeating an agent create no longer builds a second agent:

    - While a create runs, the same request (same name and settings) attaches to it instead of starting another one. It gets the same progress, then the same agent, with `resumed: true` on the `complete` event. A request for that name with other settings answers 409 `AGENT_CREATE_IN_PROGRESS`.
    - Repeating a create that already finished returns the agent it made instead of `AGENT_NAME_TAKEN`, for a day or until that agent is deleted.
    - A create whose API process stopped part-way ends as `AGENT_CREATE_INTERRUPTED` (503) after two minutes without progress. Its `details` name the sandbox it may have left behind, and the name can be used again.
    - `POST /agent-runtimes/:id/agents` holds the name the same way, and now refuses a name already in use (`AGENT_NAME_TAKEN`).
    - Create responses carry an `x-agent-create-request` header naming the request. A client that lost the connection can repeat the request with that header: it follows that create to whatever end it came to, its agent or its error, and never starts another. An unknown or mismatched id answers 404 `AGENT_CREATE_NOT_FOUND`.
    - The NDJSON stream sends a blank line every 15 seconds so that proxies and client idle timers don't cut a long step.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - Agent create reports failures a client can act on:

    - The NDJSON stream's `error` event now carries the `code`, `status` and `details` the same failure would have as a plain HTTP response (for example `RUNTIME_LIMIT_REACHED` with the plan's `current`, `limit` and `planName`).
    - A create whose placement cannot be resolved now fails with an ordinary HTTP error instead of leaving the stream without a response.
    - A name already in use answers `AGENT_NAME_TAKEN`, with the existing agent's id in `details`; renaming an agent onto a taken name does the same.
    - Adding an agent to a sandbox that already runs the framework refuses credentials in the request (`JOIN_INHERITS_CREDENTIALS`) instead of silently dropping them: the agent uses the credentials of the instance it joins.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - `PATCH /agents/:id` with `mcp` changes only the scopes it names, as its contract says: a scope left out keeps its MCP servers, and an empty string clears one. The whole per-scope map used to be replaced, so an update of Claude Code's `user` scope dropped the `project` scope's servers, and the next push emptied the workspace's `.mcp.json`. The merge happens in the database, so two scope edits at once both land. Reading a machine's MCP config back into Manyfold (`POST /agents/:id/mcp/refresh`) likewise writes only the scopes it read in. The web app now sends only the scope it edits.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - `PATCH /agents/:id` with a `model` for a framework that keeps its model in the agent's model settings (Claude Code, Codex, Gemini CLI, pi, Antigravity CLI) is still refused, now with the code `AGENT_MODEL_IN_MODEL_CONFIG` and `details: { agentId, framework }`, so a client can send the model to `/agents/:id/model-config` instead. Nothing in the request is written, a new name included.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - The `/api/agent-setup.md` runbook starts with one read-only check of the agent's machine. That check finds an `mf` in `~/.local/bin` that is not on PATH, and ignores other programs named `mf`. It also flags `MF_TOKEN` and tells whether the user's browser is on this computer.
    - A profile already signed in to the deployment is now reused on every deployment, so running the setup again, or on a machine with an existing staging login, needs no new approval. No command uses a saved token before its profile is matched to this API.
    - SSH sessions and Linux machines without a display go straight to the one-time-code sign-in. If a stable `mf` has no `--print-auth-url`, the runbook checks for a newer release, and otherwise reports that remote sign-in is not available yet.
    - The browser sign-in now waits for the login process to exit. The `"ok":true` it used to wait for never appears in the CLI's formatted output.
    - Codex runs the sign-in in the foreground, because it stops background processes.
    - The plugin step names the Codex desktop app's own CLI, and ends by listing what it installed.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - Automations run at the time of day their schedule names in their own timezone, whatever timezone the server runs in. On a server not set to UTC (a self-hosted install with `TZ` set, or a local stack), every run was off by the server's own UTC offset: a daily 09:00 in Asia/Shanghai ran at 17:00 on a server set to Asia/Shanghai, and every "next run" read the same. Around a daylight-saving change the schedule now follows RFC 5545: a time the clocks skip runs on the offset before the change (a 01:30 in London runs at 02:30 on the March change day, where it ran an hour early), and a time they repeat runs once, at its first showing. A next run already set keeps its time; the ones after it follow this.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - A Claude Code turn that continues a session is recorded on the model it ran on and at its own cost. Since Claude Code 2.1.277 a resumed run restores its session's cost ledger, so the cost it reports is the session's running total and its first listed model is the session's first. Manyfold stored those as the turn's: a turn run on Haiku after a switch from Sonnet was recorded as Sonnet at the whole session's cost, and in any longer session every turn's recorded cost grew with the session. The model now comes from the run's own start-up line, and a resumed run is priced from its own tokens at the price table's rates (`costSource: 'table'`; subagent spend, which those tokens leave out, is not included). A session's first turn keeps the cost Claude Code reports. Rows recorded before this change are not corrected.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - A Claude Code conversation opened in a sandbox's terminal (the browser terminal or herdr) runs the agent's model. The terminal resumed it with the platform's credentials but no `--model`, and on resume Claude Code falls back to the model the session last used, so after a switch (say from Sonnet to Haiku) the terminal kept running the old one. It now gets the agent's model and its model mapping, as a chat turn does. A terminal on the sandbox's own sign-in is unchanged, and when the agent's settings cannot be read the terminal resumes as before.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - Agent create progress lists only the steps a create actually goes through:

    - A new sandbox reports starting its runner as a step of its own, right after the VM is made. That wait, about 20 seconds, used to sit under "creating workspace" with nothing on screen.
    - A cloud computer (k8s) create lists the steps it reports, instead of Kubernetes objects no create ever named. An external agent's list is validating and adding the agent.
    - No list includes the network policy step: it is part of making the VM.
    - The admin console's create page and a pending agent's page use the same lists as the web, so a service framework on a sandbox shows its install and service steps.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - A saved change to an agent's MCP servers, or to its context document, reaches the machine even when another configuration push is using it. A machine takes one configuration push at a time; the push a save starts used to give up at once when another held the machine (the context document's push, the push after a daemon reconnects, another agent's on the same machine), leaving the change undelivered until the daemon next reconnected. Linking or unlinking a Composio connection started two such pushes together, so one of them was always lost. A save's push now waits for the machine, up to 100 seconds, and `POST /agents/:id/mcp/materialize` waits up to 20 seconds, then answers 409 `DAEMON_CONFIG_BUSY` instead of a 400 whose only sign was its message.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - A user's export no longer carries the secrets in their agents' MCP server config. Each scope of an agent's MCP servers is stored as the framework's own config text (JSON for Claude Code and Gemini CLI, TOML for Codex), and the export's redaction only walked JSON keys, so the `env` values, `headers`, `http_headers` and tokens inside that text reached the bundle as written. The export now reads each scope in its format and withholds what can carry a secret: `env`, headers, tokens and client secrets, a server's `args` (where connection strings go), and the credentials and query of its URL. The rest of the config keeps its shape, and text that cannot be read is withheld whole.

- [#633](https://github.com/manyfold-open/manyfold/pull/633) [`5046b4c`](https://github.com/manyfold-open/manyfold/commit/5046b4c236513b9e4fda75fd4117838c7c9a6507) Thanks [@yingca1](https://github.com/yingca1)! - Deleting a Hermes agent whose profile Hermes no longer has now succeeds. The check for an already-deleted profile looked for wording Hermes never prints, so such an agent could not be deleted at all, and a shell's "command not found" would have counted as a successful delete.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - Creating an agent on an existing sandbox (`POST /agents` with `sandboxId`) now checks that the sandbox belongs to the account the agent is created for, under the same rules as installing a framework onto it, and answers 404 `SANDBOX_NOT_FOUND` otherwise. Adding an agent to a runtime checks the runtime's owner the same way.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - The model provider list (`GET /model-providers`) now reports `managedRank` on managed rows where the edition ranks its channels. It gives the order in which "Manyfold managed" picks a channel when several can serve an agent, lowest first, so every client resolves that choice the same way.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - Clearing an agent's model on a model provider works. `PATCH /agents/:id/model-config` with `model: null` (what `mf model-config update --clear-model` sends) kept the saved model for Claude Code, Codex, Gemini CLI and pi, so the clear changed nothing. It now puts the agent back on the framework's default there: for Claude Code the alias a new agent on the provider gets (`sonnet` where the provider has a Sonnet), for Codex the first supported model the provider was tested with, for Gemini CLI `auto` (on a gateway, its default model), and for pi the credential's own default. Antigravity CLI and a subscription sign-in already cleared this way.

- [#633](https://github.com/manyfold-open/manyfold/pull/633) [`5046b4c`](https://github.com/manyfold-open/manyfold/commit/5046b4c236513b9e4fda75fd4117838c7c9a6507) Thanks [@yingca1](https://github.com/yingca1)! - An OpenClaw agent's chat now runs as that agent. Every turn used to go to OpenClaw's `main` agent, so an agent added to an OpenClaw runtime answered with `main`'s workspace and settings; the session now names the agent's own OpenClaw id (`main` for the framework's own agent). A chat started earlier with such an agent continues in a fresh OpenClaw session of the right agent.

    Rewriting the gateway's config (a credentials, environment or control UI change) also keeps the agents OpenClaw added: the rewrite used to drop them, and each one failed its next turn.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - A new sandbox is refused before anything is made when its runner could never call this API back:

    - When `PUBLIC_API_BASE_URL` points at an address a sandbox provider's VM cannot open (localhost, a `.local` name, a private or loopback IP, as on a local stack without a tunnel), creating an agent on a new sandbox and `POST /sandboxes` answer 503 `SANDBOX_API_UNREACHABLE` with the address in `details.apiUrl`. No quota slot, sandbox name or VM is spent on it.
    - A new sandbox whose runner did not connect answers `SANDBOX_RUNNER_NOT_CONNECTED` (503) and names the address it had to reach, instead of `SANDBOX_DAEMON_OFFLINE` with no reason.
    - A `PUBLIC_API_BASE_URL` that already ends in `/api` no longer becomes `/api/api` in the address a sandbox's runner is given.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox whose Manyfold CLI is too old for a file operation says why, as `SANDBOX_CLI_TOO_OLD`. Files, uploads (including chat attachments) and services on a sandbox need what newer CLIs bring; when the sandbox's CLI lacks it, the API tries to update it first. When that did not help, the reason was dropped and every sandbox got the same 503 `runtime_unavailable`: "the Manyfold CLI on sandbox-002 is too old for this, and no update carrying what it needs is published yet", even when a newer build could be installed. The answer is now a 409 `SANDBOX_CLI_TOO_OLD` that carries the actual reason, for example "sandbox-002 already runs the latest Manyfold CLI (4.8.0), which does not support this yet", with `details: { hostId, hostName, cliVersion, latestCliVersion }`, so a client can point at the sandbox's update. Cloud computers and your own computers keep `runtime_unavailable`, and a computer's message is unchanged. A chat turn refused because a sandbox's runner is too old now says to update the sandbox's Manyfold CLI from the Update Center (or `mf sandbox update`), instead of asking an administrator.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - Discovering skills no longer answers as if a repo had none because it has not been read yet. The first discover after a skill repo is added (a fresh install's built-in repos, or one added with `mf skills repos create`) used to start reading it in the background and answer without it, so the catalog showed a single skill until a later look. `GET /skills/discover` now reads such repos before answering, and waits for another server reading one, for up to 15 seconds; a repo that takes longer, or fails, is named in the page's new `pendingRepos`, which the web app's skills catalog shows as "still reading". Repos read before still refresh in the background, and only a first page waits.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox whose sprite sprites.dev made after the request for it timed out is no longer left running and billing with nothing pointing at it. The create request gives up after 15 s, and the rollback's delete could run before sprites.dev had finished making the sprite, so the sprite came up afterwards with no sandbox for it. After a timed-out or dropped create, the API now looks for the sprite under the sandbox's name for about half a minute and, when it appears, uses it, so the sandbox is created after all; only when it does not appear does the create fail and roll back as before.

## 9.4.0

### Minor Changes

- [#628](https://github.com/manyfold-open/manyfold/pull/628) [`e0090e6`](https://github.com/manyfold-open/manyfold/commit/e0090e6460b97ac549615a29e2e783d139f3bbc4) Thanks [@yingca1](https://github.com/yingca1)! - Deleting an agent that stands for its runtime's built-in profile (a Hermes `default` or OpenClaw `main` row on a sandbox or cloud computer) now removes the agent without asking the framework to delete that profile. The framework refused ("Cannot delete the default profile"), so neither that agent nor its runtime and sandbox could be deleted. The profile stays, because the runtime's primary agent runs as it.

- [#628](https://github.com/manyfold-open/manyfold/pull/628) [`e0090e6`](https://github.com/manyfold-open/manyfold/commit/e0090e6460b97ac549615a29e2e783d139f3bbc4) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox whose activity tasks cannot be read no longer shows an empty task list. `GET /api/sandboxes/:id/tasks` and its admin route answer 503 with the reason. A stop that cannot read the tasks finishes its other steps and warns that the tasks were not checked. Before, it failed after the services were already stopped, or reported that nothing on the sandbox could be stopped.

## 9.3.0

### Minor Changes

- [#620](https://github.com/manyfold-open/manyfold/pull/620) [`27b8ca8`](https://github.com/manyfold-open/manyfold/commit/27b8ca89fc1ab39d586b3a9be0254c6fcb23dbde) Thanks [@yingca1](https://github.com/yingca1)! - The built-in model catalog of Claude Code, Codex and Gemini CLI is one file, `packages/shared/src/framework-model-catalog.yaml`, and every release applies it right after the migrations (`node dist/db/migrate.js`, the self-hosted `api-migrate` service included). A row the file lists is set to what the file says, so admin edits to those rows last until the next release; a row an admin added is left alone. `node dist/db/framework-catalog.js import [--file <catalog.yaml>] [--dry-run]` applies a catalog on demand, and `export` writes the database's catalog as YAML (`just catalog-import`, `just catalog-export`).

    Codex agents can run GPT-6 Sol, with reasoning up to `ultra`, and GPT-6 Luna, up to `max`, both with the fast tier. A provider that serves GPT-6 Sol but not GPT-6 Astra defaults new agents to it. GPT-5.4, GPT-5.4 Mini and GPT-5.2 are retired, as they are in Codex itself: an agent set to one of them is asked to choose a supported model. The model the platform writes into a host's Codex config is GPT-5.6 Sol, which every channel serves and ChatGPT sign-in keeps (GPT-5.5 leaves Codex for ChatGPT sign-in on 2026-10-14); a host picks it up the next time its credentials are written. A Codex terminal that resumes a session on the platform provider runs the agent's model.

    Claude Code runtime-local model lists offer Opus 5, Opus 5.5, Sonnet 5.5 and Fable 5.1. Opus 5.5 and Sonnet 5.5 fall back to medium effort, as Claude Code starts them, and an explicitly chosen Fable model is labelled Fable in the composer.

## 9.2.0

### Minor Changes

- [#617](https://github.com/manyfold-open/manyfold/pull/617) [`1b6cc24`](https://github.com/manyfold-open/manyfold/commit/1b6cc249b0b07215dd6468ad3883be0f063e1977) Thanks [@yingca1](https://github.com/yingca1)! - A program left running in a sandbox terminal from before terminals moved to the sandbox's daemon no longer keeps that sandbox running for good. The exec-session reaper now ends a terminal (TTY) exec session once it is more than six hours old, even while it is still drawing to the screen. An operator's own console session on a sandbox is ended the same way. The reaper's log line and telemetry say whether a session was ended for being idle or for its age.

### Patch Changes

- [#617](https://github.com/manyfold-open/manyfold/pull/617) [`1b6cc24`](https://github.com/manyfold-open/manyfold/commit/1b6cc249b0b07215dd6468ad3883be0f063e1977) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox stays awake for work that starts on it just as earlier work lets go of it. The earlier work's release and the new work's hold could reach the sandbox together, and when the release landed last the sandbox could fall asleep under the new work for up to ten minutes.

- [#617](https://github.com/manyfold-open/manyfold/pull/617) [`1b6cc24`](https://github.com/manyfold-open/manyfold/commit/1b6cc249b0b07215dd6468ad3883be0f063e1977) Thanks [@yingca1](https://github.com/yingca1)! - Sandboxes fall asleep again after gemini and codex turns, after a turn picked back up following an API restart, and after a session is imported from a terminal. Each of those read the agent's session history from the sandbox and left it held awake, and billed as active, until the API restarted; a history read now keeps the sandbox awake only while it runs. A turn that fails before it starts no longer keeps its sandbox awake either.

## 9.1.2

### Patch Changes

- [#612](https://github.com/manyfold-open/manyfold/pull/612) [`c33ff97`](https://github.com/manyfold-open/manyfold/commit/c33ff976c527e90aa6764bf3eb5427c3a0acaf98) Thanks [@yingca1](https://github.com/yingca1)! - Deleting the last agent on a sandbox runtime works again: the runtime is removed with it and the sandbox is kept for reuse. It answered 409 "runtime still has agents" because the check counted the agent being deleted, and the sandbox then could not be deleted either.

## 9.1.1

### Patch Changes

- [#610](https://github.com/manyfold-open/manyfold/pull/610) [`ed34953`](https://github.com/manyfold-open/manyfold/commit/ed34953951e13b9b3f91ed26c34bc7ed38b07c19) Thanks [@yingca1](https://github.com/yingca1)! - The power sync's sprites listing, polled every few seconds, no longer writes a debug log line for every page it reads.

## 9.1.0

### Minor Changes

- [#604](https://github.com/manyfold-open/manyfold/pull/604) [`ccb4d42`](https://github.com/manyfold-open/manyfold/commit/ccb4d42dad41c01b92c2afde36e30605f9d560cc) Thanks [@yingca1](https://github.com/yingca1)! - Everything the API does on a sandbox or a cloud computer now goes through that provider's adapter or through the machine's daemon. Skills are written through the daemon on every kind of machine, and the Hermes skill list on a cloud computer is read the same way. A sandbox or cloud computer still provisioning 30 minutes after it was created is marked failed so it can be deleted; before, only cloud computers were. A host whose machine is gone from its provider fails with "the machine is gone from its provider". With the Hermes dashboard on, a cloud computer routes its hostname through the dashboard proxy, the way a sandbox does. The sandbox stop audit records the machine under `machine`.

- [#604](https://github.com/manyfold-open/manyfold/pull/604) [`ccb4d42`](https://github.com/manyfold-open/manyfold/commit/ccb4d42dad41c01b92c2afde36e30605f9d560cc) Thanks [@yingca1](https://github.com/yingca1)! - Bringing up a sandbox's daemon now gives a registered daemon a moment to reconnect by itself after the sandbox thaws, as it already did after an explicit wake. Before, when the sandbox already read as running, the daemon was restarted even if it had just reconnected, which ended the work it was still carrying.

- [#604](https://github.com/manyfold-open/manyfold/pull/604) [`ccb4d42`](https://github.com/manyfold-open/manyfold/commit/ccb4d42dad41c01b92c2afde36e30605f9d560cc) Thanks [@yingca1](https://github.com/yingca1)! - The admin chat session detail names the host that ran each turn instead of its sprite, so turns on a cloud computer are identified too. The turn record keeps the host id from the start of the turn; the sprite name and the exec session id it used to keep are gone, since nothing read the session id any more. Turns recorded before the update show only their placement.

## 9.0.0

### Major Changes

- [#600](https://github.com/manyfold-open/manyfold/pull/600) [`dd95865`](https://github.com/manyfold-open/manyfold/commit/dd95865edb66b70938773a5ff16c415bbd928ad7) Thanks [@yingca1](https://github.com/yingca1)! - OpenClaw, Hermes and other service frameworks on a sandbox now run as services of the sandbox's daemon, as they do on a cloud computer: the daemon starts them, restarts them after a crash and starts them again when the sandbox restarts, and the sandbox's public address reaches them through a stub the platform registers. Their configuration, which holds the provider key and the gateway token, is written readable by its owner only; it was readable by every user of the sandbox. Deleting a service framework's runtime now removes its services and the sandbox's public route, which before stayed running. Changing an OpenClaw runtime's credentials rewrites its configuration too, and the Hermes dashboard's services and front proxy run under the daemon beside the gateway. A sandbox stop stops a framework's services through the daemon, and the next message starts them again. An admin can restart a runtime's service with its own settings (`POST /api/admin/agent-runtimes/:id/service/restart`).

    A framework module now registers one `serviceRecipe` for both kinds of host in place of `spriteService` and `podService`, and its install and configure steps receive the host's home and whether it sleeps. The service-start report route (`POST /api/internal/runtime-reports`) is gone: a service is ready when the daemon reports it healthy, which Manyfold announces as the `runtime.service.ready` event, formerly `runtime.report.ready`.

### Minor Changes

- [#600](https://github.com/manyfold-open/manyfold/pull/600) [`dd95865`](https://github.com/manyfold-open/manyfold/commit/dd95865edb66b70938773a5ff16c415bbd928ad7) Thanks [@yingca1](https://github.com/yingca1)! - A service framework prepared on a sandbox or a cloud computer before its first agent now works end to end. An OpenClaw runtime with no model provider yet starts its gateway without one; before, its setup failed on "cannot resolve base_url". The gateway's built-in profile is left for the first agent that joins instead of being listed as an agent of its own, which OpenClaw would then refuse to delete, leaving the runtime undeletable. Deleting a service framework's runtime now also removes its services and the machine's route to it; before, only the record went and the service kept running.

- [#600](https://github.com/manyfold-open/manyfold/pull/600) [`dd95865`](https://github.com/manyfold-open/manyfold/commit/dd95865edb66b70938773a5ff16c415bbd928ad7) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox's daemon now runs under the sandbox's own service supervisor, in a loop that restarts it whenever it exits. Before, the daemon was started from a command and did not survive the sandbox's environment restarting (a cold boot or a checkpoint restore), so the next action on the sandbox had to start it again first. A daemon started the old way is handed over to the loop the next time Manyfold brings it up. Updating a sandbox's Manyfold CLI now applies by the daemon exiting and the loop starting the new version. The daemon's loop and the stub that routes the sandbox's public address are listed as managed on the sandbox's services, and a sandbox stop or a service delete leaves both alone. A sandbox's public address is now the one the sandbox reports: the address derived from its name lacked the organisation's suffix and did not answer.

## 8.5.0

### Minor Changes

- [#595](https://github.com/manyfold-open/manyfold/pull/595) [`5b8faf4`](https://github.com/manyfold-open/manyfold/commit/5b8faf4284a20c2e869af75df8b631271f04ada6) Thanks [@yingca1](https://github.com/yingca1)! - Serve `GET /api/agent-setup.md`, a public markdown runbook an AI coding agent follows to connect itself to this deployment: install `mf` (a private dev-channel copy on staging-style deployments), sign in under a profile of its own, verify, add the Claude Code or Codex plugin, and hand off with the exact command to use. Each deployment renders it from its own `PUBLIC_API_BASE_URL`, `MF_WEB_URL` and CLI channel; a request `Host` is used only when no public URL is configured, and only if it is a bare host and port.

- [#593](https://github.com/manyfold-open/manyfold/pull/593) [`bf06faf`](https://github.com/manyfold-open/manyfold/commit/bf06faf34668647946ce4db0f8737b28428c5a98) Thanks [@yingca1](https://github.com/yingca1)! - Upgrading a sandbox's Manyfold CLI now keeps the sandbox awake until the updated daemon reports back, and the upgrade answers with the new version. The sandbox no longer falls asleep during the handover and shows the old CLI until its next wake.

- [#596](https://github.com/manyfold-open/manyfold/pull/596) [`531abbb`](https://github.com/manyfold-open/manyfold/commit/531abbbc92c356c7640ae028b6c39d492a85be6c) Thanks [@yingca1](https://github.com/yingca1)! - Codex chats no longer open every answer with two failed tool calls. The `config.toml` Manyfold writes for codex dropped the `disable_response_storage` and `network_access` settings, which current codex ignores and reported as an error on each turn. A codex agent created before this keeps the warning until its credentials are saved again, which rewrites the file.

- [#596](https://github.com/manyfold-open/manyfold/pull/596) [`531abbb`](https://github.com/manyfold-open/manyfold/commit/531abbbc92c356c7640ae028b6c39d492a85be6c) Thanks [@yingca1](https://github.com/yingca1)! - Creating a coding agent on a sandbox now sets its framework up through the sandbox's daemon, the way a cloud computer does. It no longer logs codex in with the platform key, which left the key in `~/.codex`, and no longer spends a paid Claude Code check turn. A custom workspace is checked and admitted by the daemon, and the agent's context doc is delivered once the agent exists. Resuming a codex conversation in the sandbox terminal now follows the sandbox's model-credentials setting, like Claude Code, pi and Antigravity CLI: the TUI gets the platform key for that session only.

- [#596](https://github.com/manyfold-open/manyfold/pull/596) [`531abbb`](https://github.com/manyfold-open/manyfold/commit/531abbbc92c356c7640ae028b6c39d492a85be6c) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox or cloud computer whose daemon has work in progress when it needs a newer Manyfold CLI now answers "updating once its current work finishes; retry in a few minutes" within seconds. Before, the caller waited three minutes and was told the daemon did not come back. The update is asked for once: a daemon that is draining for an update now keeps its first deadline, so asking again no longer puts the update off.

- [#596](https://github.com/manyfold-open/manyfold/pull/596) [`531abbb`](https://github.com/manyfold-open/manyfold/commit/531abbbc92c356c7640ae028b6c39d492a85be6c) Thanks [@yingca1](https://github.com/yingca1)! - Files, backups and storage readings on a sandbox or a cloud computer now go through the machine's daemon, as they already did on a self-owned computer. An upload of up to 200 MB streams in chunks and replaces its target only once it has fully arrived, on every kind of machine; a self-owned computer needs a Manyfold CLI with streamed writes for uploads and attachments, and says so when it is older. Backups stream both ways, without the 100 MB limit cloud computers and self-owned computers had. A sandbox's storage is measured while it is up, never as it goes to sleep, which woke it again. File errors from the machine now come back as a clear not found, conflict, forbidden or unavailable status instead of an internal error.

- [#593](https://github.com/manyfold-open/manyfold/pull/593) [`bf06faf`](https://github.com/manyfold-open/manyfold/commit/bf06faf34668647946ce4db0f8737b28428c5a98) Thanks [@yingca1](https://github.com/yingca1)! - A framework upgrade on a sandbox keeps the sandbox awake from its first step through verification. Before, a rebuilt service such as Hermes could time out while starting on a sandbox that had fallen asleep, which left the service down. OpenClaw's service restart after an in-place upgrade no longer has that problem either.

- [#596](https://github.com/manyfold-open/manyfold/pull/596) [`531abbb`](https://github.com/manyfold-open/manyfold/commit/531abbbc92c356c7640ae028b6c39d492a85be6c) Thanks [@yingca1](https://github.com/yingca1)! - A Manyfold API instance that shuts down, on a deploy or a restart, now lets go of the sandboxes it was holding awake. Before, each hold it left behind kept its sandbox running, and counting active hours, for up to 30 minutes after the work had ended.

- [#596](https://github.com/manyfold-open/manyfold/pull/596) [`531abbb`](https://github.com/manyfold-open/manyfold/commit/531abbbc92c356c7640ae028b6c39d492a85be6c) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox kept awake is now held by Manyfold itself, which renews the hold from the API, instead of by a loop running inside the sandbox. Switching keep-awake off lets a running sandbox go at once, and never wakes a sleeping one to do it. Stopping a sandbox turns keep-awake off, a sleeping one included, so it is not woken again. Sandbox task lists show the keep-awake hold as Manyfold's, and it cannot be deleted there.

- [#596](https://github.com/manyfold-open/manyfold/pull/596) [`531abbb`](https://github.com/manyfold-open/manyfold/commit/531abbbc92c356c7640ae028b6c39d492a85be6c) Thanks [@yingca1](https://github.com/yingca1)! - Every terminal now opens through the machine's daemon, a sandbox's own shell included, and a sleeping sandbox is woken for it. The provider's own exec channel is no longer a fallback. A cloud computer's bare terminal carries the user's API token for its session, like a sandbox's, behind the same terminal switch. Stopping a sandbox detaches the terminals open on it, so it can sleep; an owned terminal keeps its shell for the next attach.

### Patch Changes

- [#595](https://github.com/manyfold-open/manyfold/pull/595) [`5b8faf4`](https://github.com/manyfold-open/manyfold/commit/5b8faf4284a20c2e869af75df8b631271f04ada6) Thanks [@yingca1](https://github.com/yingca1)! - A hosted sandbox or pod whose daemon was registered against an earlier public API address (a replaced tunnel, a changed domain) is registered again on its next bring-up instead of being started against the old address and never connecting. The bring-up's single inspect exec now also reads the saved address; before, every bring-up ended in `daemon did not come online` while the sandbox was held awake.

## 8.4.0

### Minor Changes

- [#590](https://github.com/manyfold-open/manyfold/pull/590) [`a007e4b`](https://github.com/manyfold-open/manyfold/commit/a007e4bfa0abb80c6341452115fea387f0bcf1e5) Thanks [@yingca1](https://github.com/yingca1)! - Holding a sandbox awake is now checked instead of assumed. The platform's awake hold is created or renewed and then confirmed in the sandbox's task list, and a release is confirmed the same way. The hold is named as the platform's own: the sandbox's Tasks list shows it as a keep-awake lease, it cannot be deleted there, and stopping a sandbox leaves it in place so a turn in progress finishes first (the stop says so). The active-hours enforcer's stop still removes everything. Reads that must not wake a sandbox no longer wake it to take a hold, and switching keep-awake off on a sleeping sandbox no longer wakes it. Restoring a backup to a self-owned computer works for archives up to the daemon's single-write limit instead of failing above about 96 KB, and the terminal's workspace preparation runs in the workspace it names.

- [#590](https://github.com/manyfold-open/manyfold/pull/590) [`a007e4b`](https://github.com/manyfold-open/manyfold/commit/a007e4bfa0abb80c6341452115fea387f0bcf1e5) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox or cloud computer whose Manyfold CLI lacks something a turn needs now has its CLI updated on the spot, and the turn goes on once the updated daemon is back, instead of failing as "runner unavailable". The turn asks for a CLI update only when even the latest CLI lacks it or the machine cannot update itself. A computer of your own that lacks it is told to update its CLI, rather than that the runner is unavailable.

- [#590](https://github.com/manyfold-open/manyfold/pull/590) [`a007e4b`](https://github.com/manyfold-open/manyfold/commit/a007e4bfa0abb80c6341452115fea387f0bcf1e5) Thanks [@yingca1](https://github.com/yingca1)! - Work on a sandbox now keeps it awake for as long as the work runs, not just while its daemon comes up:

    - framework version probes, upgrades, diagnostics, and Hermes and OpenClaw agent setup;
    - installing a framework on a sandbox or cloud computer;
    - MCP and context-document delivery;
    - an open terminal, until its tab closes.

    Installing or refreshing an agent's context document on a sandbox that has gone to sleep wakes it for the write, instead of failing.

    A command whose connection drops while the sandbox wakes is resent once, and the daemon picks up the one already running instead of starting it twice. Cloud computer scripts no longer put secrets in the command's input, which the daemon keeps on disk for up to a day; they travel in its environment instead.

- [#590](https://github.com/manyfold-open/manyfold/pull/590) [`a007e4b`](https://github.com/manyfold-open/manyfold/commit/a007e4bfa0abb80c6341452115fea387f0bcf1e5) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox's active hours now accrue from the same power state that holds its concurrent-sandbox slot: while its daemon is heartbeating, a sandbox that sprites.dev misreports as asleep is metered as running instead of holding a slot for free. A sandbox kept running this way is also sampled on the fast cadence, so metering stops within seconds of the daemon going quiet.

## 8.3.0

### Minor Changes

- [#586](https://github.com/manyfold-open/manyfold/pull/586) [`60d28ae`](https://github.com/manyfold-open/manyfold/commit/60d28ae99603ff33c0ce52d742e9823ee8b60c2c) Thanks [@yingca1](https://github.com/yingca1)! - An agent's Storage page (titled Storage) shows its workspace and config sizes for a sandbox from the sandbox's last storage measurement, so they are there while the sandbox sleeps, with when they were measured. Refresh measures the sandbox now: admitted like any other wake, it wakes a sleeping sandbox and updates the paths and the sandbox filesystem size together, even within minutes of the last measurement. An agent on a sandbox shows that filesystem size as Storage in its Overview's Details. `POST /agents/:id/storage-usage/refresh` (`agents:edit`) is the new measuring call, `POST /agents/:id/storage-usage` never execs for a sandbox, and its report carries `measuredAt`; `mf agent storage-usage` reports a sleeping sandbox's cached paths instead of unknowns.

- [#586](https://github.com/manyfold-open/manyfold/pull/586) [`60d28ae`](https://github.com/manyfold-open/manyfold/commit/60d28ae99603ff33c0ce52d742e9823ee8b60c2c) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox runtime's framework version is stored as the version itself ("2.1.251"), not the line the CLI printed ("2.1.251 (Claude Code)", "codex-cli 0.151.0"), so it compares with the catalog and an update is offered when one is out. A version the platform just installed or upgraded in place no longer reverts to the old one while the sandbox's daemon still reports its cached inventory.

- [#586](https://github.com/manyfold-open/manyfold/pull/586) [`60d28ae`](https://github.com/manyfold-open/manyfold/commit/60d28ae99603ff33c0ce52d742e9823ee8b60c2c) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox's agents and the concurrent-sandboxes count now agree on whether it is running: a suspended or stopped sandbox reads as wakeable even while its daemon's last heartbeat is recent, a daemon that connects marks its sandbox running at once, and a sandbox whose daemon is heartbeating counts as running even when sprites.dev lags or misreports its status.

- [#586](https://github.com/manyfold-open/manyfold/pull/586) [`60d28ae`](https://github.com/manyfold-open/manyfold/commit/60d28ae99603ff33c0ce52d742e9823ee8b60c2c) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox's Runtimes section has a refresh button beside "+" that probes the sandbox for every framework on it now, through its daemon, instead of showing what the daemon last reported, which could be minutes old, or older while the sandbox slept. The probe wakes the sandbox; opening the page still only reads the last report. `POST /sandboxes/:id/detect-frameworks` takes `{ "probe": true }` for this, and Detect frameworks left the sandbox's "…" menu.

### Patch Changes

- [#585](https://github.com/manyfold-open/manyfold/pull/585) [`ea584d9`](https://github.com/manyfold-open/manyfold/commit/ea584d93bd286949ec96c247d7b0c9d0ba186c5a) Thanks [@yingca1](https://github.com/yingca1)! - A Claude Code chat session whose saved conversation can no longer be loaded on its runtime recovers on the next message instead of failing every turn with `error_during_execution`.

## 8.2.0

### Minor Changes

- [#579](https://github.com/manyfold-open/manyfold/pull/579) [`85898dd`](https://github.com/manyfold-open/manyfold/commit/85898ddeb468d6cec8c30fd741511cd6941448c9) Thanks [@yingca1](https://github.com/yingca1)! - Show subscription quota windows for Codex, Claude Code, and Antigravity accounts in runtime account cards and the composer model-source panel.

## 8.1.2

### Patch Changes

- [#578](https://github.com/manyfold-open/manyfold/pull/578) [`b078222`](https://github.com/manyfold-open/manyfold/commit/b078222ff1f507aa315ca42a3ba3aa9fa53c2003) Thanks [@yingca1](https://github.com/yingca1)! - Fix Antigravity provider/model editing by connecting the model picker to the validated draft and exposing refresh and validation errors. Run enabled provider-specific Gemini model IDs through agy's native custom model registration, preserving exact gateway routes, native OAuth isolation, built-in model variants and terminal resume behavior.

## 8.1.1

### Patch Changes

- [#574](https://github.com/manyfold-open/manyfold/pull/574) [`92f736a`](https://github.com/manyfold-open/manyfold/commit/92f736aefda4ebddb79b0c6093a14a41ffb586d4) Thanks [@yingca1](https://github.com/yingca1)! - Keep runtime-local turns independent of saved Managed provider capacity. Validate Antigravity API-key models, including its default, against the provider's enabled upstream IDs in model settings and before dispatch. Show unverified or incompatible models as unavailable and refresh compatibility when switching providers.

- [#573](https://github.com/manyfold-open/manyfold/pull/573) [`2fb0b15`](https://github.com/manyfold-open/manyfold/commit/2fb0b1563bce38df7e21754d21412e3734d00946) Thanks [@yingca1](https://github.com/yingca1)! - Allow hosted agents without an initial provider binding to open the credentials picker and save their first model provider.

## 8.1.0

### Minor Changes

- [#569](https://github.com/manyfold-open/manyfold/pull/569) [`e4eab55`](https://github.com/manyfold-open/manyfold/commit/e4eab559326beea7f664310bba47002a270a638d) Thanks [@yingca1](https://github.com/yingca1)! - A turn now carries the directories it runs in — the agent's workspace and
  its framework's home — on the exec itself, instead of registering them with
  the daemon in a separate call just before the turn. A message to an agent
  whose workspace sits outside the machine's managed tree (a coding agent on
  a sandbox it shares with a service framework) no longer depends on that
  extra round trip landing before the machine sleeps; the daemon admits the
  exec's directory for that exec only. A daemon too old to read them is asked
  to update before the turn rather than failing mid-turn.

- [#569](https://github.com/manyfold-open/manyfold/pull/569) [`e4eab55`](https://github.com/manyfold-open/manyfold/commit/e4eab559326beea7f664310bba47002a270a638d) Thanks [@yingca1](https://github.com/yingca1)! - A machine that can sleep is now held awake for exactly as long as the
  platform works on it, and only then. One lease per machine covers the wake,
  the daemon's reconnect, the admission and the turn, so a sandbox that
  suspended a moment ago no longer answers a message with "the agent's
  computer is unavailable": it is woken, held, and the turn runs. Whether a
  machine can take work is read from the socket the API holds to its daemon,
  never from the last heartbeat; a self-owned computer the API holds no
  socket to is offline and says so. Account operations, the terminal, files,
  storage and recovery use the same lease, and a call that lands on a socket
  the thaw replaced is retried once on the fresh one.

## 8.0.0

### Major Changes

- [#564](https://github.com/manyfold-open/manyfold/pull/564) [`ce45b52`](https://github.com/manyfold-open/manyfold/commit/ce45b5270e2571bcbb507cf1d33519edb83c7ac5) Thanks [@yingca1](https://github.com/yingca1)! - One machine is one host, one host has one daemon, and a runtime is one
  framework on one host. Every self-owned computer, stateful sandbox and cloud
  computer now runs a single `mf daemon` that carries all of its frameworks; the
  platform-managed runner runtimes that used to shadow each sandbox and pod are
  gone, and a host's daemon registers onto the host itself. Keep-alive moves from
  the runtime to the sandbox: the switch keeps the machine awake
  (`PATCH /sandboxes/:id/keep-awake`; `/agent-runtimes/:id/keep-alive` is
  removed), and stopping is host-level (`POST /sandboxes/:id/stop`;
  `POST /agents/:id/stop` is removed). Runtime providers replace sprites accounts
  and Kubernetes clusters in Admin (`/admin/runtime-providers`); sandboxes, pod
  hosts and agents are placed with `providerId` (`accountId` / `clusterId` are
  gone). Agent, runtime, sandbox and host summaries expose the host they live on
  (`hostId`, `hostName`, `powerState`, `daemonOnline`, `keepAwake`) and a derived
  `availability` instead of copied sprite / pod fields, agent status is the
  agent's own lifecycle (`pending` / `ready` / `failed`) and runtime status the
  install state (`installing` / `ready` / `failed`); the sprite-status stream
  emits host-status events. Daemon protocol: the register response no longer
  carries `runtimes`, the welcome frame's `runtimeIds` lists the runtimes on the
  host, and the daemon's local stores are scoped by the host id. CLI: `mf agent
create --account-id` becomes `--provider-id`; `mf runtime get`, `mf agent get`
  and `mf daemon status` print the host, provider, power state and availability.

## 7.10.0

### Minor Changes

- [#560](https://github.com/manyfold-open/manyfold/pull/560) [`1d3ae24`](https://github.com/manyfold-open/manyfold/commit/1d3ae24d614092618986bf86db2a82b30840c986) Thanks [@yingca1](https://github.com/yingca1)! - Add Antigravity CLI (Google's `agy`) as a coding agent framework. Antigravity
  CLI agents run on the stateful sandbox, Kubernetes and self-owned computer
  (daemon) runtimes and, like the other coding CLIs, take their model either
  from a platform provider — a saved or managed provider of the Gemini
  protocol, or a Gemini API key, on one of the models agy offers in its API-key
  mode — or from agy's own sign-in on the runtime: a Google account, including
  a Google AI Pro or Ultra plan, whose Claude and GPT-OSS models the model
  picker then lists too. Run `agy` in the agent's terminal to sign in. A
  platform provider never touches the runtime's own agy settings or sign-in.
  On sandboxes and Kubernetes, agy is installed at the exact release the
  Update Center pins, checked against the sha256 its GitHub release publishes,
  and its self-updater stays off there, a terminal user's `agy` included.
  Conversations resume with `agy --conversation` in chat and in the terminal,
  whose new messages sync back to the chat; the sessions panel lists agy's
  conversations; a turn cut off by an API restart finishes under its own
  message, read back from agy's conversation log; and a conversation can be
  handed to herdr 0.9.1 or newer. `mf daemon hooks install` adds agy's session
  hook: a conversation started in the terminal joins the chat list when the
  terminal closes, and leaving the TUI hands the conversation back.
  `mf agent create --framework antigravity-cli` takes `--google-api-key` and
  `--agy-model`. agy's own sign-in on a runtime needs the Manyfold CLI from this
  release there.

## 7.9.0

### Minor Changes

- [#505](https://github.com/manyfold-open/manyfold/pull/505) [`2bf2163`](https://github.com/manyfold-open/manyfold/commit/2bf2163383203952839872211b977d2e7a8cbf66) Thanks [@yingca1](https://github.com/yingca1)! - Add a shared Claude Code/Codex plugin for mf-powered platform operations,
  skill-maintained workbench route rules, and live resource updates in
  the workbench across API instances. Unify the standalone and plugin
  manyfold-cli-usage skill, with identity-aware guidance and complete
  reference bundles while retaining its default-install identity.

    Refresh channels, installed and library skills, connections, agents and model
    configuration, API-managed files, and backups through account-scoped events.
    Preserve open form drafts and file navigation while catching up after reconnects.

- [#555](https://github.com/manyfold-open/manyfold/pull/555) [`f026526`](https://github.com/manyfold-open/manyfold/commit/f0265269119d2c209d501ebb13a37ee8d4112e63) Thanks [@yingca1](https://github.com/yingca1)! - A turn on a sandbox whose runner has to be started no longer fails with "Chat runner unavailable" because the sandbox went to sleep while the runner was connecting. The sandbox is now kept awake from the moment its runner starts until the runner connects, whether a turn started it, a sign-in on the runtime page woke it, or an mf CLI upgrade restarted it. The first start after a CLI upgrade can take about a minute.

    A daemon no longer exits at startup when a herdr or coding CLI binary it finds cannot be executed, such as an empty file left behind by an interrupted install; that binary is reported without a version instead. A sandbox with an empty herdr gets herdr reinstalled the next time its runner starts, and a herdr update that cannot run herdr at all now says so instead of reporting a timeout.

- [#556](https://github.com/manyfold-open/manyfold/pull/556) [`8cc4d50`](https://github.com/manyfold-open/manyfold/commit/8cc4d508dd09a88a50aee3783122603f43e9971c) Thanks [@yingca1](https://github.com/yingca1)! - Upgrading OpenClaw's version on a sprite now restarts its gateway onto the new version. sprites.dev has no service restart endpoint: the upgrade installed the new binary, then failed with a 404 and left the gateway running the old version. It now stops the service and starts it again, and it reports an error instead of claiming a restart if sprites.dev refuses to stop the service.

- [#556](https://github.com/manyfold-open/manyfold/pull/556) [`8cc4d50`](https://github.com/manyfold-open/manyfold/commit/8cc4d508dd09a88a50aee3783122603f43e9971c) Thanks [@yingca1](https://github.com/yingca1)! - OpenClaw turns on sprites are no longer refused with `openclaw_daemon_gateway_unavailable` when the sprite has just woken up. A sprite's gateway is a service the platform runs, like a cloud computer's, so only a BYOD daemon's heartbeat probe can refuse a turn now. A sprite runner takes that probe as it connects, a few seconds before the gateway it woke with starts answering, so the probe said the gateway was down when it was only booting.

### Patch Changes

- [#553](https://github.com/manyfold-open/manyfold/pull/553) [`c22ee13`](https://github.com/manyfold-open/manyfold/commit/c22ee132083522c0836b766ad0131c66d1ae2f4d) Thanks [@yingca1](https://github.com/yingca1)! - Harden A2A calls: invalidate peer tickets when their owner is deactivated, recover task results after a server restart, block DNS rebinding, and preserve concurrent agent configuration updates. Apply CLI send deadlines to discovery and streaming, report remote cancellation consistently, retain input and authentication prompts, and preserve HTTP error status and reasons.

## 7.8.0

### Minor Changes

- [#550](https://github.com/manyfold-open/manyfold/pull/550) [`9e7e87d`](https://github.com/manyfold-open/manyfold/commit/9e7e87dbe867ae61cb311f6828cfa8e4633cb814) Thanks [@yingca1](https://github.com/yingca1)! - Managed model channels now recognise an empty account pool when the gateway reports it as `503 Service temporarily unavailable`, including the plain-text form codex prints. The channel breaker opens on the first such turn, so later turns end at once with the channel-unavailable message instead of each running the CLI's full retry chain against the empty pool.

## 7.7.0

### Minor Changes

- [#545](https://github.com/manyfold-open/manyfold/pull/545) [`a5f1f45`](https://github.com/manyfold-open/manyfold/commit/a5f1f45b099309f581cc12bd7fcac3e2468390f4) Thanks [@yingca1](https://github.com/yingca1)! - Daemons now need Manyfold CLI 4.6.1 or newer, the release that carries the scoped storage reports, Pi's session home, services on cloud computers and Hermes turns that no longer stall at startup. The API refuses registration, heartbeats and connections from an older daemon, and `mf doctor` and the daemon's refusal message name the new minimum.

    A daemon started by launchd or systemd against the official API updates itself within about six hours once it is idle. A daemon started by hand, or one pointed at a self-hosted API with auto-update off, stays refused until `mf update` runs and the daemon restarts. Sprite runners and cloud computers below the minimum are reinstalled when they are next used, and the cloud computer image now starts with CLI 4.6.1, so a new cloud computer registers straight away.

## 7.6.1

### Patch Changes

- [#537](https://github.com/manyfold-open/manyfold/pull/537) [`5f3b536`](https://github.com/manyfold-open/manyfold/commit/5f3b536d00e0d02e7fd51296112c4069fe2f2227) Thanks [@yingca1](https://github.com/yingca1)! - Fix A2A peer authorization and task delivery across the API, CLI and workbench:

    - Outbound peer grants use the current batch endpoint, and revocation addresses the target agent.
    - Reject private IPv4 addresses encoded as IPv4-mapped IPv6 in outbound A2A URLs.
    - Serialize message retries by caller and target before creating a session or starting a turn.
    - Preserve cancellation during turn startup and return the durable task state when completion races with cancellation.
    - Resubscribe to the persistent Chat event stream until the task finishes, with cleanup on client disconnect.
    - Respect artifact snapshots and replacements in external A2A responses. Human CLI streaming prints the final artifact text once; JSON mode continues to emit live events.

## 7.6.0

### Minor Changes

- [#538](https://github.com/manyfold-open/manyfold/pull/538) [`052dc96`](https://github.com/manyfold-open/manyfold/commit/052dc961470ec76d4e0894fe393079cc0fe440d2) Thanks [@yingca1](https://github.com/yingca1)! - A cloud computer's Manyfold CLI now updates itself when something needs a newer one. Installing a service framework (OpenClaw, Hermes) on a computer whose CLI predates services updates the CLI first, and a computer whose daemon is below the supported floor is updated before its turns run. When there is no newer CLI to install, creating the agent fails right away with `POD_HOST_DAEMON_TOO_OLD` and a message that says so, instead of a generic install failure after the install has run.

## 7.5.0

### Minor Changes

- [#532](https://github.com/manyfold-open/manyfold/pull/532) [`7fb7f6d`](https://github.com/manyfold-open/manyfold/commit/7fb7f6d6b574204fd9d67bb7da32bcc294dd0b6b) Thanks [@yingca1](https://github.com/yingca1)! - A framework an edition registers (ADR-0034) can now run as a service on cloud computers. Its extension brings a pod service recipe (`podService`: how the framework is installed on the computer and the service its daemon keeps up), and the registry requires one for a service framework whose definition lists `k8s`. A recipe's install receives the repository its version was admitted from, and `rebuildShells` receives the framework's home on the host being rebuilt, so an edition's in-place version change works on a cloud computer as well as on a sandbox.

- [#531](https://github.com/manyfold-open/manyfold/pull/531) [`2ede298`](https://github.com/manyfold-open/manyfold/commit/2ede298f1d330e84e858d0081338c96fec9deb43) Thanks [@yingca1](https://github.com/yingca1)! - OpenClaw and Hermes run on cloud computers, and the create flow offers a cloud computer to install them on. The framework goes onto the computer's volume and its gateway becomes a service of the computer's daemon, which starts it, restarts it with a backoff after a crash, and keeps it running across the daemon's own updates; each framework gets its own address on the cluster's ingress, and its runtime is ready once the gateway answers its health check. Changing credentials or environment variables, toggling the OpenClaw Control UI and changing the framework version rewrite the service and restart it; removing the runtime stops the service and withdraws its address. The first agent of an OpenClaw or Hermes runtime is the gateway's built-in profile, as on a sandbox. The daemon advertises `services.v1` (service upsert, start, stop, delete and list) under the container startup method. The runtime host image moves to Node 24, which current OpenClaw requires.

    Also fixed on every runtime: an OpenClaw turn no longer fails with "model not found" when OpenClaw lists the agent's model with its provider prefix; a Hermes install pinned to a release runs that release's installer; a failed Hermes version change keeps the working install instead of removing it; and the daemon hands Hermes a FIFO for its output, since under the compiled CLI Hermes read its stdout as closed and turns stalled at the ACP handshake.

- [#530](https://github.com/manyfold-open/manyfold/pull/530) [`bfe1271`](https://github.com/manyfold-open/manyfold/commit/bfe1271d5ce433f2156b7b3cb1b055040625851b) Thanks [@yingca1](https://github.com/yingca1)! - Cloud computers are now generic Kubernetes pod hosts. Each one runs the `manyfold-runtime-host` image with its whole home directory on a persistent volume, and frameworks are installed into it on demand: Claude Code, Codex, Gemini CLI and pi, several on one computer, each at the version a sandbox would get (the admin default, else the latest) and upgradable in place. The computer's own daemon carries every turn, and provider credentials travel with each turn instead of being stored on the computer. A new `/pod-hosts` API lists, creates, renames and deletes cloud computers, installs a framework on one and updates its CLI; the Cloud computers settings page, the agent create flow and the Update Center use it. Files, backups and the terminal reach a cloud computer through pod exec, so nothing on it is published over HTTP. Deployments set `K8S_RUNTIME_IMAGE` to a published host image; the per-framework `K8S_IMAGE_*` settings are no longer read.

- [#533](https://github.com/manyfold-open/manyfold/pull/533) [`de4c7a6`](https://github.com/manyfold-open/manyfold/commit/de4c7a696d8f439bb64f6a5797181b4958a085fb) Thanks [@yingca1](https://github.com/yingca1)! - Only the pod host image is built and published now: every cloud computer runs `manyfold-runtime-host` and installs its frameworks on demand, so the per-framework runtime images (`manyfold-runtime-base`, `-runner`, `-claude-code`, `-codex`, `-gemini-cli`, `-pi`, `-openclaw`, `-hermes`), their recipes and their local build recipes are gone. Tags already published stay pullable. The buy-container page describes a cloud computer that frameworks are installed on, rather than a pod with a framework runtime.

### Patch Changes

- [#529](https://github.com/manyfold-open/manyfold/pull/529) [`26d155f`](https://github.com/manyfold-open/manyfold/commit/26d155ff7220e576933f2284bdf64868ae826e2d) Thanks [@yingca1](https://github.com/yingca1)! - The daemon recognises a new startup method, `container`, set by the boot loop of the pod host runtime image: under it the daemon accepts `daemon.update` and restarts by exiting, while auto-update stays off so the platform decides its version. The self-owned machines page labels it "autostart · container". The new `manyfold-runtime-host` image carries the toolchains and OS packages frameworks need but no framework, for pods that install frameworks on demand; its boot loop keeps the daemon's mf on the pod's volume and falls back to the image's copy when an update will not stay up.

## 7.4.0

### Minor Changes

- [#513](https://github.com/manyfold-open/manyfold/pull/513) [`d5befb6`](https://github.com/manyfold-open/manyfold/commit/d5befb6338020d320087ea69f25868e5d303472c) Thanks [@yingca1](https://github.com/yingca1)! - The open-source build now ships only the core frameworks: Claude Code, Codex, Gemini CLI, Pi, OpenClaw, Hermes, Dify, Langflow and A2A. Any other framework is added by an edition through the framework registry, together with its API module, its web and admin presentation, and any sign-in hand-off it brings. An agent whose framework the running build does not register fails with `framework_unavailable`. The landing page, the create flows, the admin's runtime hint and the CLI's usage help describe the core set.

## 7.3.0

### Minor Changes

- [#510](https://github.com/manyfold-open/manyfold/pull/510) [`d8acbd9`](https://github.com/manyfold-open/manyfold/commit/d8acbd96b37d288ebce8a0d1c9d3bbe8d1b40067) Thanks [@yingca1](https://github.com/yingca1)! - Per-framework API behaviour — agent and chat adapters, sprite and k8s bootstraps, version descriptors, framework-served files, the control UI link, channel hooks and keep-alive supervision — now resolves through one extension registry that a framework's own module registers into, instead of being wired into the core by name. A chat turn for a framework with no adapter now fails with `framework_unavailable` rather than being answered by the development echo adapter, and turning on agent-managed replies for an agent whose framework cannot deliver them now says that its framework does not support them.

- [#509](https://github.com/manyfold-open/manyfold/pull/509) [`849e518`](https://github.com/manyfold-open/manyfold/commit/849e51893c1893009b58adc5c91b9360d7c7313b) Thanks [@yingca1](https://github.com/yingca1)! - Framework facts — runtimes, chat capabilities, version sources, reserved env prefixes — now come from one framework registry that an edition can extend with frameworks of its own. An agent whose framework this build does not provide now gets `409 framework_unavailable` instead of an internal error, and the web shows it under its raw framework id instead of failing to render it.

### Patch Changes

- [#511](https://github.com/manyfold-open/manyfold/pull/511) [`1b66a70`](https://github.com/manyfold-open/manyfold/commit/1b66a709399ced6506236f64e860b6d0080ea9d4) Thanks [@yingca1](https://github.com/yingca1)! - The workbench and the admin console now take framework names, logos, create-flow entries and per-framework behaviour from the framework registry rather than from fixed lists, so a framework an edition registers shows up wherever the built-in ones do; on the API side, such a framework's own module registers its definition. The composer's agent picker now names Pi, Dify, Langflow and A2A agents instead of showing a generic "Agent", and the admin's framework default-versions page lists frameworks in registry order under their full names.

## 7.2.0

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

### Patch Changes

- [#341](https://github.com/manyfold-open/manyfold/pull/341) [`eb5eb47`](https://github.com/manyfold-open/manyfold/commit/eb5eb473ec0fc8cd86484a49220ff6e657eb6b7b) Thanks [@yingca1](https://github.com/yingca1)! - An agent added to a sandbox that already exists, which is how the four-step
  create flow always adds one, now gets its Manyfold context doc
  (`AGENTS.manyfold.md` and the reference in its instruction file), as an agent
  created with its own sandbox always did. And a Codex turn that another API
  instance finished after a restart no longer comes back as duplicate messages
  the next time the conversation syncs with the runtime.

- [#341](https://github.com/manyfold-open/manyfold/pull/341) [`eb5eb47`](https://github.com/manyfold-open/manyfold/commit/eb5eb473ec0fc8cd86484a49220ff6e657eb6b7b) Thanks [@yingca1](https://github.com/yingca1)! - Agents that run on their CLI's own sign-in (Local config) on a sandbox now
  resume a conversation in the terminal and in herdr on that sign-in. The
  terminal used to require the platform model credentials instead — which such
  an agent does not have — and fell back to a plain shell. A Local-config turn
  on a sandbox runtime whose first agent never bound a provider no longer fails
  for want of a stored credential either. And a Gemini CLI agent added to an
  existing self-owned computer with a Cloud provider now runs on that provider
  instead of the computer's own sign-in.

## 7.1.0

### Minor Changes

- [#495](https://github.com/manyfold-open/manyfold/pull/495) [`ffb7124`](https://github.com/manyfold-open/manyfold/commit/ffb7124d82bb231fea4b6ae36d3a46bbbaae2ee0) Thanks [@yingca1](https://github.com/yingca1)! - Hand a chat session to herdr. When an agent's runtime has herdr installed — your own computer running the daemon, or a sandbox — the chat header's "Switch to TUI" becomes "Switch to herdr": the conversation's Claude Code or Codex TUI opens in a herdr pane (a workspace per agent, a tab named after the conversation), and the web's terminal view shows that herdr with the pane focused. Views follow the conversation on their own: a session held by herdr shows herdr, quitting the TUI there brings the chat back with what was said imported, and "Switch to Chat UI" takes the conversation back. The banner's Show in herdr / Continue in web / Back to web buttons are gone; the header switch is the only control. Sandboxes get herdr installed when their runner is set up, and the Update Center lists herdr next to the mf CLI for every machine and sandbox, with upgrade (and install) actions; the runtime detail page shows the herdr version. `mf daemon status` and `mf daemon doctor` report herdr availability and version.

### Patch Changes

- [#496](https://github.com/manyfold-open/manyfold/pull/496) [`52dec83`](https://github.com/manyfold-open/manyfold/commit/52dec83dcc14479da0eff2957ff9d37b4bb43fd4) Thanks [@yingca1](https://github.com/yingca1)! - herdr handoff follow-ups. Handing a sandbox conversation to herdr now honours the sandbox's terminal opt-in, like the browser terminal: the web asks to enable the terminal first, and the API refuses a sandbox whose terminal is off before waking its runner. A Claude Code handoff on a sandbox without model credentials in the terminal says which setting to turn on. Sandboxes that get herdr from the platform skip herdr's first-run welcome. In the web, right-clicks inside the embedded herdr go to herdr's own menu instead of the browser's; a conversation left in herdr comes back in herdr when you return to it or reload, and moving between conversations herdr holds keeps the same view and only moves herdr's focus; the notes that sat above the composer about herdr and the Chat UI move behind a "?" after the header's view switch (a stuck import keeps its banner, with retry and abandon). The daemon no longer raises a herdr notification each time the web moves focus. Handing the same conversation to herdr again takes over its existing tab instead of adding another, and a daemon that restarts (an upgrade, a sandbox runner brought back after a suspension) adopts the herdr panes it opened, so their conversations stay handed off and their tabs still close.

## 7.0.1

### Patch Changes

- [#490](https://github.com/manyfold-open/manyfold/pull/490) [`da6954f`](https://github.com/manyfold-open/manyfold/commit/da6954f699b13d9b4472f4490438ce63c1316b4e) Thanks [@yingca1](https://github.com/yingca1)! - Allow a fresh runner turn of a gateway framework to reach its local gateway before the gateway has lazily created the agent workspace. Runner admission no longer rejects that not-yet-created workspace; coding and Hermes workspace checks remain unchanged. Session history reads now hold a Sprite awake through daemon filesystem and gateway RPC work, then release the lease.

## 7.0.0

### Major Changes

- [#486](https://github.com/manyfold-open/manyfold/pull/486) [`d97866a`](https://github.com/manyfold-open/manyfold/commit/d97866a0a6c86fab0570dae607e8f52a4f2e3985) Thanks [@yingca1](https://github.com/yingca1)! - Require an mf daemon runner for all runtime-backed chat, including model inspection, history, cancellation and permission answers. Remove direct Sprite/Pod exec and API-owned ACP/gateway chat transports, runner rollout switches, and the Claude partial-stream toggle. Enable safe cursor recovery and managed Claude delta streaming unconditionally.

    Existing environments without a compatible runner must update their daemon or Pod image before chatting. K8s service images must start a runner with persistent state; Pods with a runner sidecar additionally require MF_POD_RUNNER_IMAGE to name the runner image. External Dify, Langflow and A2A integrations retain their HTTP transport.

## 6.1.1

### Patch Changes

- [#481](https://github.com/manyfold-open/manyfold/pull/481) [`218ae1a`](https://github.com/manyfold-open/manyfold/commit/218ae1ad42326206a5b30dee24abf7e1535c8ad5) Thanks [@yingca1](https://github.com/yingca1)! - Profile-bound sprites agents now probe and run through their sandbox runner. The runtime-local model refresh brings the runner up (same admission and awake hold as an account wake) instead of failing with `auth_context_unsupported`, and turn dispatch always attempts the runner for a turn that requires an auth profile — the rollout list only governs turns that could also run on the bare sprite exec. Codex profile turns also select the builtin OpenAI provider explicitly, so a sandbox whose shared config.toml still pins the platform gateway from a platform-source bootstrap no longer posts subscription credentials at that gateway (401 INVALID_API_KEY).

## 6.1.0

### Minor Changes

- [#469](https://github.com/manyfold-open/manyfold/pull/469) [`ad37487`](https://github.com/manyfold-open/manyfold/commit/ad37487e6d93bf1510fb0d4a83fd0f77db701f53) Thanks [@yingca1](https://github.com/yingca1)! - Make a terminal's hold on a chat session explicit, and gate the next turn on importing what it wrote (ADR-0029 §1, §2).

    - Resuming a session's TUI in the terminal now takes the session's writes as its last step. While held, web sends, channel messages, A2A tasks and the OpenAI-compatible endpoint are refused with a stable `409 session_held_by_terminal`; channel messages get a notice, ones already queued stay queued. The invariant is a database CHECK, so two writers can no longer share one transcript.
    - The chat view shows "Open in a terminal · Back to web" over a read-only composer; a second tab sees the same and can release from there. Closing the terminal, a reconnecting tab, or a lease that ran out (the reaper, audited) all release it by killing the process through its handle first.
    - Releasing stamps the import pending in the same statement and imports the terminal's transcript; a turn is refused with `409 session_import_pending` until that import has actually read the transcript, with one bounded retry at the gate, a manual retry, and an explicit abandon (automatic when the runtime is no longer the one the terminal wrote on).
    - Sprites terminals now kill their exec session on close instead of leaving it running and billed; daemon terminals wait for the pty close ack before releasing.

- [#470](https://github.com/manyfold-open/manyfold/pull/470) [`19a9156`](https://github.com/manyfold-open/manyfold/commit/19a9156d511e7750f9cea2473041f63c1719f404) Thanks [@yingca1](https://github.com/yingca1)! - Terminals now tell the platform which CLI session they are on (ADR-0029 §3, hook reporting).

    - `mf daemon hooks install | uninstall | status`: Manyfold's `SessionStart` / `SessionEnd` hooks for `claude` and `codex`, written as one marked script plus one marked entry per event in `~/.claude/settings.json` and `~/.codex/hooks.json`, next to your own hooks. `mf daemon register` asks once (`-y` says yes, `--no-hooks` says no); the choice is remembered and `mf daemon start` keeps the hooks current. A sprite runner installs them by default. The hooks act only inside a terminal Manyfold opened (`MF_TERMINAL_ID`), never print, and are not installed on Windows.
    - API: `POST /terminal/session-hooks`, reachable only with the token of a live Manyfold terminal. A resume that came back under a new id, or a compaction that changed it, moves the chat session to the new ref after importing the old ref's tail; a TUI that opens an idle chat session takes its hold; one that opens a session with a turn in flight, or held by another terminal, is left alone and the tab is warned; a session that started fresh in the terminal (`startup`, `/clear`, fork) becomes a chat session of its own — marked `origin: terminal` — when the terminal ends, if its transcript is not empty; `SessionEnd` gives the hold back and runs the import without waiting for the terminal to close.
    - Every terminal Manyfold opens now carries the full four-key runtime identity (`MF_API_URL` and `MF_DEPLOY_ENV` were missing on the daemon arm) plus `MF_TERMINAL_ID`, registered as terminal surfaces of the exec env contract.

- [#475](https://github.com/manyfold-open/manyfold/pull/475) [`673428d`](https://github.com/manyfold-open/manyfold/commit/673428d2d6eb25334f6edd22de25d45987e9b26e) Thanks [@yingca1](https://github.com/yingca1)! - Terminals on daemon agents now belong to the daemon rather than to the browser tab showing them (ADR-0029 §6). The daemon keeps the shell and a headless copy of its screen when the tab's connection drops or the tab closes; the workbench's reconnect, or the next open of a terminal for a session that shell holds, attaches to the same shell and gets the screen back, taking it over from any other tab (which is told with close code 4409). A terminal nobody is attached to is closed after 30 minutes, or 5 minutes under a runtime auth profile; "Back to web" ends it at once. The daemon lists the terminals it owns in every hello and heartbeat, and the platform now takes that list, not the tab's tunnel, as proof that a terminal's hold is alive: a terminal the daemon no longer reports has its row ended and its hold released, and a terminal no row claims is closed. `mf daemon status` shows the terminals kept and attached; a daemon keeps at most 8. Daemons without the capability (`pty.terminal.v1`) keep the previous stream-bound behaviour.

### Patch Changes

- [#473](https://github.com/manyfold-open/manyfold/pull/473) [`035e697`](https://github.com/manyfold-open/manyfold/commit/035e697bb9a1ee84b1296bee029cd95e2abc2ac3) Thanks [@yingca1](https://github.com/yingca1)! - `mf daemon stop` now also ends the execs the daemon owns (by their recorded identity), and `--keep-execs` leaves them for the next daemon to adopt — which is what the platform's runner bring-up passes once a daemon advertises `exec.files.v1`. The systemd user unit `mf daemon start` writes carries `KillMode=process`, so a detached exec outlives the daemon's restart; whether that holds for the actual installation is decided at start (launchd: yes; systemd: only with `KillMode=process`; manual: no), logged as `exec survival`, reported by `mf daemon doctor`, and used by the update drain, which only waits for sessions that would die with the daemon and keeps admitting adoptable execs while an update is pending. `mf daemon status` shows how many running execs would survive a restart.

- [#474](https://github.com/manyfold-open/manyfold/pull/474) [`b8e1f90`](https://github.com/manyfold-open/manyfold/commit/b8e1f90b12273e34809097c04a824a2f7d513e75) Thanks [@yingca1](https://github.com/yingca1)! - A daemon started without an init unit (`manual`: the sprite runner, `mf daemon start --foreground`) can now take a remote upgrade when it is a standalone macOS / Linux binary and not the pod runner (ADR-0029 §5). The old process drives it: the downloaded binary must pass `--version` before it replaces anything (now true for every self-update), the running binary is kept as `<mf>.prev`, the daemon hands its running execs to a successor it starts detached and watches the successor answer on the control socket with the new version; if that never happens it stops the successor, restores `.prev`, relaunches it and refuses that target version until another one is chosen. The daemon advertises `daemon.update.manual` when it can do this, so the dashboard's upgrade works for such daemons and the platform upgrades a capable sprite runner through `daemon.update` instead of installing over it. A restarted daemon also tells the platform once, in its first hello, what it made of the execs it inherited and whether an upgrade was rolled back; both are recorded as audit entries on the daemon.

- [#467](https://github.com/manyfold-open/manyfold/pull/467) [`6567ab2`](https://github.com/manyfold-open/manyfold/commit/6567ab2f2f26bc4241044e103339b21ed40565cf) Thanks [@yingca1](https://github.com/yingca1)! - Automatically retry saved MCP and platform context configuration when a supported daemon reconnects. Serialize manual, on-change and reconnect delivery per computer, keep failed or superseded snapshots stale, and protect configuration files against delayed writes from retired connections or expired delivery attempts. Older daemons keep explicit push support and require a CLI update for automatic delivery.

## 6.0.0

### Major Changes

- [#463](https://github.com/manyfold-open/manyfold/pull/463) [`11ebadb`](https://github.com/manyfold-open/manyfold/commit/11ebadb44f2f97a89fd7d5a92cec1dc863492b30) Thanks [@yingca1](https://github.com/yingca1)! - Replace ambiguous agent `storageBytes`/`storageMeasuredAt` fields with nullable `workspaceBytes`/`workspaceMeasuredAt`. Add scoped cached sandbox storage reports, measurement freshness and conservative path attribution; runtime account reads require explicit account intent and `agents:read` consent.

    `mf sandbox storage-usage` reports the current sandbox, while `--account` reports all account sandboxes. `mf agent list --json` now returns `{ scope, agents }`; agent path diagnostics keep sleeping measurements unknown and expose cached sandbox usage separately. Upgrade the API and CLI together: storage commands and agent list/get reject older ambiguous responses.

### Patch Changes

- [#458](https://github.com/manyfold-open/manyfold/pull/458) [`51d0ab8`](https://github.com/manyfold-open/manyfold/commit/51d0ab80531ed75e0792cea8020c7ed4c6a3fc0c) Thanks [@yingca1](https://github.com/yingca1)! - Bound Chat connection recovery, offer reconnect and reload when status remains unavailable, and correlate stream closure without exposing conversation content.

- [#462](https://github.com/manyfold-open/manyfold/pull/462) [`10655d1`](https://github.com/manyfold-open/manyfold/commit/10655d1478157db16fe2b65ff168b173772257ed) Thanks [@yingca1](https://github.com/yingca1)! - Retain the latest daemon hello across runtime preparation and failed open-turn lookups, retrying once per connection until the database recovers without requiring another reconnect. Release historical inventory after a successful lookup and discard retired connection evidence without disrupting newer connections.

- [#463](https://github.com/manyfold-open/manyfold/pull/463) [`11ebadb`](https://github.com/manyfold-open/manyfold/commit/11ebadb44f2f97a89fd7d5a92cec1dc863492b30) Thanks [@yingca1](https://github.com/yingca1)! - Fence sandbox storage measurements across API instances, retain old readings on failure, and back off repeated failures without waking sleeping sandboxes. Publish host and successful workspace readings atomically and report bounded, privacy-safe measurement phases.

## 5.1.13

### Patch Changes

- [#453](https://github.com/manyfold-open/manyfold/pull/453) [`a79482f`](https://github.com/manyfold-open/manyfold/commit/a79482fbaebc604d9a2dc7d061650ba28f08b3e9) Thanks [@yingca1](https://github.com/yingca1)! - Resume quota-blocked automation schedules when allowance returns, using the actual usage period and the next future occurrence without replaying missed runs.

- [#446](https://github.com/manyfold-open/manyfold/pull/446) [`5653efb`](https://github.com/manyfold-open/manyfold/commit/5653efb06acb4602599ad62f27d8ab26e4d8aa4b) Thanks [@yingca1](https://github.com/yingca1)! - Send Lark OPUS and MP4 attachments as audio and video messages, and stop retrying permanent file/message type mismatches without resending successful text.

- [#453](https://github.com/manyfold-open/manyfold/pull/453) [`a79482f`](https://github.com/manyfold-open/manyfold/commit/a79482fbaebc604d9a2dc7d061650ba28f08b3e9) Thanks [@yingca1](https://github.com/yingca1)! - Keep quota warnings pending until a connected client acknowledges them, revalidate current allowance before confirmation, and preserve delivery across API instances and reconnects.

- [#452](https://github.com/manyfold-open/manyfold/pull/452) [`3ac88d8`](https://github.com/manyfold-open/manyfold/commit/3ac88d8c869831c543d3092c7d6435d5063a7b65) Thanks [@yingca1](https://github.com/yingca1)! - Keep newly provisioned Kubernetes containers pending until their first agent and configuration are complete. Failed creates now remove only their owned resources, or retain a visible failed container for a safe Delete retry when cleanup cannot finish. Fence concurrent attachment, chat, runner registration, and deletion during this operation.

## 5.1.12

### Patch Changes

- [#441](https://github.com/manyfold-open/manyfold/pull/441) [`3178178`](https://github.com/manyfold-open/manyfold/commit/3178178023a0a1a2f07da45d43fe56f309d8825d) Thanks [@yingca1](https://github.com/yingca1)! - Resolve managed model prices and pins within the served channel, preserve the verified provider scope across interrupted coding turns, and keep provider-specific prices isolated from other channels. Platform Gemini machine turns preserve native configuration and system policy through isolated temporary settings.

- [#443](https://github.com/manyfold-open/manyfold/pull/443) [`7493519`](https://github.com/manyfold-open/manyfold/commit/74935192b76073a5077600961057ea17c1d5a5df) Thanks [@yingca1](https://github.com/yingca1)! - Read public GitHub Skill sources anonymously at an immutable revision, with shared request and size budgets. Reuse unchanged repository snapshots, fence concurrent scans across API instances, and publish complete catalog updates atomically without replacing curation. Report source failures with sanitized diagnostics and preserve imported source revisions.

- [#444](https://github.com/manyfold-open/manyfold/pull/444) [`a7077b8`](https://github.com/manyfold-open/manyfold/commit/a7077b8ad57df2024af50f2c6d3ea1c4ae1910e5) Thanks [@yingca1](https://github.com/yingca1)! - Keep WeChat inbound polling active when getupdates returns HTTP 524, preserving the cursor and initial-sync baseline. Fast edge timeouts use a short cancellable delay; other HTTP, network and expired-session failures retain their existing behavior.

## 5.1.11

### Patch Changes

- [#438](https://github.com/manyfold-open/manyfold/pull/438) [`1d02ace`](https://github.com/manyfold-open/manyfold/commit/1d02ace01988ae8063004d71a9f41041fe9598ad) Thanks [@yingca1](https://github.com/yingca1)! - Admit git framework versions and their source repositories together before agent creation, sandbox preparation and upgrades. Reject unavailable repository pins and prevent installation failures from retrying an unadmitted git default, while preserving npm and image fallback behavior.

- [#435](https://github.com/manyfold-open/manyfold/pull/435) [`8fa222c`](https://github.com/manyfold-open/manyfold/commit/8fa222c576053f0c65c83fdd00a2d75a0b63aa8e) Thanks [@yingca1](https://github.com/yingca1)! - Record user-cancelled chat turns as a terminal cancelled outcome and show them neutrally in Admin session summaries, turn tables, and transcripts. Keep genuine historical failures in the Has errors filter while preserving raw cancellation events for inspection.

## 5.1.10

### Patch Changes

- [#424](https://github.com/manyfold-open/manyfold/pull/424) [`9d69bf0`](https://github.com/manyfold-open/manyfold/commit/9d69bf0bff642180f246a4079047ce062d31d74b) Thanks [@yingca1](https://github.com/yingca1)! - Preserve Gemini CLI snake-case tool call IDs, names, parameters and correlated results during dispatch and replay. Classify explicit Codex overload and HTTP 429 retry-limit exits as retryable provider failures, with distinct bounded causes and no automatic replay.

- [#426](https://github.com/manyfold-open/manyfold/pull/426) [`1d4b66e`](https://github.com/manyfold-open/manyfold/commit/1d4b66eb7cd87b374e638563eb05c830f9a87532) Thanks [@yingca1](https://github.com/yingca1)! - Keep a bounded reconciliation retry when an overlapping daemon hello reports a resumable Chat stream but its open-turn lookup fails. Recovery re-reads the open turn and uses the latest hello's exact ref without requiring another reconnect.

- [#430](https://github.com/manyfold-open/manyfold/pull/430) [`b5270ff`](https://github.com/manyfold-open/manyfold/commit/b5270ff448ee08fa0c97b2180a40d1b3ef2bde07) Thanks [@yingca1](https://github.com/yingca1)! - Assemble the API runtime offline from locked dependencies and verify the complete production dependency graph before publishing its image.

## 5.1.9

### Patch Changes

- [#419](https://github.com/manyfold-open/manyfold/pull/419) [`b1708bf`](https://github.com/manyfold-open/manyfold/commit/b1708bfc8ce44ff1f285bf9edf9cc7f037cea43b) Thanks [@yingca1](https://github.com/yingca1)! - Keep Sentry's default performance instrumentation from adding duplicate Axiom spans, and carry one three-second fatal exit deadline through turn handoff and telemetry delivery. Flush the exit record and captured error before pending span conversion while preserving the graceful signal budget.

- [#418](https://github.com/manyfold-open/manyfold/pull/418) [`08b3b0e`](https://github.com/manyfold-open/manyfold/commit/08b3b0ed5fc09a7af592b071f5e1e53f70e4eedb) Thanks [@yingca1](https://github.com/yingca1)! - Persist self-host chat uploads across API container replacement and restrict the default CORS allowlist to the configured Web and Admin origins. Self-host accounts can inspect their effective resource quotas and usage without cloud billing actions.

## 5.1.8

### Patch Changes

- [#412](https://github.com/manyfold-open/manyfold/pull/412) [`2fec6e2`](https://github.com/manyfold-open/manyfold/commit/2fec6e2323ecbe16057ed1f707842f1663551f39) Thanks [@yingca1](https://github.com/yingca1)! - Install configured default skills on runtime-attached agents, including daemon, existing sprites, and Kubernetes agents. Preserve existing skill intents and report installation failures without failing agent creation.

- [#413](https://github.com/manyfold-open/manyfold/pull/413) [`76fabab`](https://github.com/manyfold-open/manyfold/commit/76fababb74b3a9716ffc4c633fe9d0491923db07) Thanks [@yingca1](https://github.com/yingca1)! - Show deferred daemon upgrades and pending or failed skill materialization accurately in the Update Center. Prevent overlapping framework and sandbox CLI upgrades across API instances and disable competing update controls while a queued update owns their target.

## 5.1.7

### Patch Changes

- [#404](https://github.com/manyfold-open/manyfold/pull/404) [`601e052`](https://github.com/manyfold-open/manyfold/commit/601e05234243c4644b8320b941872fb1d37efd9c) Thanks [@yingca1](https://github.com/yingca1)! - Preserve trace recording for detached chat work by creating a real OpenTelemetry root span instead of an unsampled synthetic parent. Retain the initiating identity, correlation attributes and original task completion ordering.

## 5.1.6

### Patch Changes

- [#400](https://github.com/manyfold-open/manyfold/pull/400) [`7950001`](https://github.com/manyfold-open/manyfold/commit/795000137d4d9ccbbf4b087876a9ff30cf55928f) Thanks [@yingca1](https://github.com/yingca1)! - Isolate background telemetry scopes, stop collecting automatic HTTP breadcrumbs, and strip query and fragment data from Sentry requests, breadcrumbs and transaction spans before sending.

## 5.1.5

### Patch Changes

- [#396](https://github.com/manyfold-open/manyfold/pull/396) [`415f45a`](https://github.com/manyfold-open/manyfold/commit/415f45ab8f2df2367de27c7dcb26b617a36d8fb3) Thanks [@yingca1](https://github.com/yingca1)! - Keep one daemon process per profile, preserve the current owner's PID and control socket during concurrent starts or cleanup, and recover ownership after a crash. Ignore obsolete WebSocket callbacks, keep reconnect attempts single-flight, and preserve new RPC cancellation handlers when older connections finish. Include optional process identity and complete hello records for diagnosing connection churn. Existing duplicate foreground processes should be stopped before updating and restarting the same profile.

## 5.1.4

### Patch Changes

- [#391](https://github.com/manyfold-open/manyfold/pull/391) [`a06ff77`](https://github.com/manyfold-open/manyfold/commit/a06ff77cffdf47b7998784243dd5a7d59ee71b52) Thanks [@yingca1](https://github.com/yingca1)! - Allow interrupted backup and restore cleanup to finish when only exited, unreaped processes remain in a runtime container. Continue blocking retry while any member of the operation's process group is still alive or its state cannot be determined, and retain the operation timeout when descendants outlive their group leader.

## 5.1.3

### Patch Changes

- [#387](https://github.com/manyfold-open/manyfold/pull/387) [`f65315a`](https://github.com/manyfold-open/manyfold/commit/f65315ab77838f0efb5289b91c424900ed805344) Thanks [@yingca1](https://github.com/yingca1)! - Reject overlapping backup and restore operations on the same workspace across API replicas. Keep operation ownership through archive transfer and cleanup, preserve active jobs when another API starts, and recover interrupted operations before allowing a retry. Remote archive and restore commands record cancellation state so a delayed command cannot overwrite a newer operation.

## 5.1.2

### Patch Changes

- [#383](https://github.com/manyfold-open/manyfold/pull/383) [`fb5412f`](https://github.com/manyfold-open/manyfold/commit/fb5412f572f375cd15e18ee22b1df1320d666c30) Thanks [@yingca1](https://github.com/yingca1)! - Require STARTTLS before SMTP authentication or message delivery when implicit TLS is disabled. Relays without a working TLS upgrade now fail before any password or email is sent. Clarify the TLS modes in Admin settings and preserve significant leading and trailing whitespace in SMTP passwords.

## 5.1.1

### Patch Changes

- [#375](https://github.com/manyfold-open/manyfold/pull/375) [`ed12eb7`](https://github.com/manyfold-open/manyfold/commit/ed12eb7babcd48713fd3ff796f8c2f2cabab4ec8) Thanks [@yingca1](https://github.com/yingca1)! - Keep daemon chat turns suspended across repeated disconnects instead of marking an unfinished response complete when a replayed output identity deduplicates its suspension event.

- [#377](https://github.com/manyfold-open/manyfold/pull/377) [`dff686e`](https://github.com/manyfold-open/manyfold/commit/dff686e9d8821b9bc68e4cc1c69576209450e9ad) Thanks [@yingca1](https://github.com/yingca1)! - Preserve Gemini's structured provider error when the CLI exits unsuccessfully, even if startup warnings fill the stderr preview. Redact and bound error summaries before attaching the stderr head and stack tail.

- [#378](https://github.com/manyfold-open/manyfold/pull/378) [`bf609bd`](https://github.com/manyfold-open/manyfold/commit/bf609bdfb96db89776f45f5c5df9dde8220fd50c) Thanks [@yingca1](https://github.com/yingca1)! - Skip automatic runtime history sync while a Sprite's exec endpoint is marked unavailable. Opening Chat no longer starts history-file commands against that endpoint; sync resumes after the turn's recovery probe clears the marker.

- [#376](https://github.com/manyfold-open/manyfold/pull/376) [`42f6c8e`](https://github.com/manyfold-open/manyfold/commit/42f6c8e4248908a126295253a006a4230b0c52b4) Thanks [@yingca1](https://github.com/yingca1)! - Avoid rewriting unchanged daemon metadata when PostgreSQL JSONB returns object keys in a different order. Heartbeats still update presence, and changed framework values or array order continue to update metadata.

## 5.1.0

### Minor Changes

- [#354](https://github.com/manyfold-open/manyfold/pull/354) [`aef0bb7`](https://github.com/manyfold-open/manyfold/commit/aef0bb74954b2e95c40cf3e29f4c333fc8ddb4d8) Thanks [@yingca1](https://github.com/yingca1)! - Agent create (v1): the model provider section is built like the runtime section — an All / Cloud / Local chip row over one grid of pick cards (the saved providers and the runtime's accounts side by side, the chips only filtering) and one row of dashed add chips under it. Cloud lists the saved providers and adds new ones through the same built-in / custom forms as Settings → Model Providers, in a dialog that refreshes the list and picks the new row. Local lists the runtime's host sign-in and its added accounts as the runtime page's Account section shows them (same identity, plan and status tags, the same Sign in for a host or account that needs one, a Manage accounts link for the rest), signs a new subscription in from the page, and can now store an API key on the runtime: an `api-key` auth profile keeps the key in its own credential context on the host and injects it as the vendor variable for that profile's runs (needs an `mf` daemon advertising `auth-api-key.v1`; the API refuses the create on older ones). The runtime page's Account section and the create form's Local group now render one shared account list (`RuntimeAccountList`): the same rows, the same Sign in button and account menu, the same dashed "+ Add account" / "+ Add API key" chips and the same sign-in dialog; the create form only adds the pick. The accounts are laid out like the create form's runtime cards, two to a line: each account is headed by who it is signed in as (the host row is simply "Host sign-in" until it is), with plan and organization on one quiet line, its status tag, and Sign in on the row when it needs one; the host's usage sits two windows to a line, and the list ends with Add account. The explanatory copy that repeated what the rows already said is gone. Joining an existing runtime no longer offers a "Same credentials as the runtime" row: for a coding framework the runtime's credentials are the Local list (its host sign-in row is that binding), so a Cloud pick is always an explicit provider; the frameworks without a Local list (openclaw, hermes, external, and those that manage providers in their own UI) simply inherit, as before, and a subscription choice no longer sends an empty credentials PATCH.

    Sandbox runners come up earlier: a coding-framework agent create registers and starts the sprite's runner while the VM is still awake from the framework install (`starting_runner` step), picking a sandbox runtime in the create form prewarms its runner (debounced, same admission and metering as a click), and a runner woken for an account operation is held awake for a few minutes so the sign-in or key that follows does not wake it again.

    A sandbox delete whose sprites.dev call fails no longer pins the user's active-slot cap: revoked host rows are excluded from every concurrent-active count, and the sandbox reaper now retries the delete for a revoked row a few minutes later instead of leaving it as a permanent ghost. A wake refused by that cap is reported as its own state (`sandbox-limit`) on the runtime page and in the create form's Local list, with a check-again action, and is never cached as a failed probe.

    Account usage is read from the vendor at most once every ten minutes per runtime: the runtime page's opens and refreshes re-read the sign-in but reuse the kept usage, a refused re-read keeps the last good numbers (the card says when they were read), and the host card's menu has Refresh usage for an explicit re-read (`GET …/account?refreshUsage=1`; the daemon's `account.inspect` and the sandbox probe both accept a usage flag).

    The create form (v1) gathers every model setting under one Advanced config section after the provider: the framework's model mapping (folded) with its default model and effort for a platform provider on Claude Code or Codex, the primary model for openclaw / hermes, or the model override for an agent that simply inherits its runtime's credentials. The mapping now applies when joining an existing runtime too: the join sets the agent's model config right after its credentials. Both the Model provider and the Advanced config labels carry the same question-mark help as the framework and runtime labels, opening a short explanation of Cloud vs Local and of what the mapping does.

    Opening the create form for a runtime (`?runtimeId=`) no longer loses that selection to the first sandbox host when the hosts load before the runtimes.

    Each sandbox card in the create form (v1) shows every framework a sandbox can hold as icons — the three coding CLIs and the service frameworks — present ones in colour with a green edge, absent ones greyed behind a dashed edge — and each icon opens a menu with the installed version against the catalog, the agents already running that framework there (each a link to its chat), and the one action that closes the gap: Check (a sandbox never probed), Install, or Upgrade to the latest. A coding CLI on a bare sandbox installs through a new `POST /sandboxes/:id/frameworks/:framework/install` (the same staged npm install as the agent-level upgrade, re-probed and persisted afterwards); a sandbox that already runs the framework upgrades through its primary agent, as the runtime page does. The service frameworks are known through the runtime that runs them and install by a click too: the menu's Install brings the framework up on the sandbox as a runtime with no agent yet (installed and started, its model provider filled in by the first agent's pick), and the menu says when the sandbox's one public port is already taken by another of the three. Deep links into the form (`?sandboxId=`, `?runtimeId=`) no longer lose their target to the first host when the lists load in the other order.

    A bare sandbox that already has the coding CLI takes a subscription account before any agent exists: picking it in the create form (a click, a deep link or a sandbox just created — never the list's own default pick, which offers Add account instead and prepares on the click) brings the framework's runtime up on it right away (`POST /sandboxes/:id/frameworks/:framework/runtime` — an agent-less runtime row, the CLI left at the version found, only a missing one installed at the version agent create would pick; idempotent over a live runtime — the form's own prewarm starts the runner) and re-targets the form at that runtime, so Codex and Gemini CLI on a sandbox show the same Local group as Claude Code — host sign-in, added accounts, Add account / Add API key — instead of a "sign in after creating" row. A sandbox never probed is checked first (its CLI inventory read while it is awake), and one whose CLI turns out to be missing gets an Install chip in the same place — so a sandbox created from the form goes straight to its accounts, or straight to installing the framework, instead of the "sign in after creating" copy. A failed step shows why, with a retry. The agent then joins the runtime the way any later one would, promoted to its primary; the runtime page lists such a runtime with zero agents until then. A credentials change for an agent on a sprites runtime that has no stored credentials yet (one prepared this way) resolves from the request instead of demanding a rebuild.

    The Model provider section has the same shape for every framework now. OpenClaw and Hermes, which speak both vendors' protocols, list the saved providers of both families in one grid under All / Anthropic / OpenAI chips that only filter (the picked card's family is the vendor the primary-model default follows), with the same dashed "Add model provider" chip offering both families' catalog entries; the old Anthropic | OpenAI toggle over a separate list is gone. A framework that takes no provider from Manyfold shows one card saying it manages its model provider in its own UI, and creating such an agent no longer demands an unrelated saved provider.

    Every runtime card in the create form's Agent runtime section has a menu bottom-right. A sandbox card — bare, or the runtime on it — offers Rename runtime, Rename sandbox and Delete sandbox (once no agent runs there; its agent-less runtimes go with it): the sandbox is the machine the card stands for, so its runtimes are not deleted one by one from here. A cloud computer's card renames its runtime and deletes it once no agent is left; a daemon's runtimes are the daemon's own and only rename.

    While a picked sandbox is still on its way to being usable, the create button says so and stays disabled — Creating the sandbox… (the new-sandbox dialog closes on the click), Checking the sandbox…, Installing <framework>…, Preparing the sandbox…, Starting the sandbox runner… — so the form cannot be submitted around a step that is still running; the runner-starting line the account list used to show is that same progress and is gone from the list.

    The create form keeps waking the picked sandbox's runner until it answers (asking again after every cycle that ends without an answer) instead of handing the user a "start runner" line and button, so those never appear there; the plan's slot-cap notice keeps a Check again. The sandbox cards' status line says what the machine is doing — Active / Warm / Cold for the VM (the runtime list's words), Starting runner… and Runner online for the picked one — instead of a flat Ready.

    Waking a sandbox runner no longer stalls on a stale twin: when two registrations left two runner-host rows for one sprite, the wake picked one arbitrarily and could wait its full two minutes on the row the process was not using; the lookup now takes the row the runner last answered on.

    A sandbox woken for its accounts no longer sits in the plan's active slot for minutes after the user has moved on. The create form's prewarm holds it for a short window it renews while the runtime stays picked and releases when the pick moves or the page closes (`POST /agent-runtimes/:id/auth-profiles/release`); the runtime page releases the hold its Refresh or sign-in placed when it is left; and a wake the slot cap refuses first lets go of the account holds on the user's other sandboxes, so the next attempt is admitted once they suspend — on the Free plan's single slot, switching sandboxes in the form used to wait out a five-minute hold.

    A sandbox wake the plan refuses fails fast in the create form instead of spinning: the prewarm's admission now runs on the request and answers with the refusal (`RuntimeAuthPrewarmView.refused`), so used-up active hours end the wait at once — the card reads Can't wake, the Local group says the hours are used up with an Upgrade plan link where a plan is sold, and Create is not held — while a full concurrent slot keeps the wait going with the button saying it is waiting for another sandbox to fall asleep.

    Every lookup of a sandbox's runner by name now agrees on which row is the runner when a double registration left two: the one it last answered on. Before, the account list could read a sandbox as asleep off the twin nothing ever connected to while the wake reported the runner live — the create form then showed Starting the sandbox runner… indefinitely. The twin rows are dropped when found, once they are old enough not to be a registration still dialling in.

## 5.0.0

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

## 4.0.0

### Major Changes

- [#340](https://github.com/manyfold-open/manyfold/pull/340) [`99a20ff`](https://github.com/manyfold-open/manyfold/commit/99a20ffb31d07d1ac6df7023a3ad265e5200ab9e) Thanks [@yingca1](https://github.com/yingca1)! - Daemon WebSocket connections now require an Authorization bearer header. Query
  parameters no longer authenticate a daemon. Upgrade every daemon to a CLI that
  advertises `ws.auth-header` before deploying this version; older clients are
  rejected with close code 4400.

    Credential scrubbing remains enabled for logs, traces and error reports,
    including rejected requests that still contain legacy query parameters.

    Sprite runner registration no longer attempts to install a system init unit.
    The platform starts the registered runner explicitly.
    Managed runners require CLI 0.34.0 or newer; older sprite installations are
    upgraded through the existing bring-up path.

## 3.1.0

### Minor Changes

- [#336](https://github.com/manyfold-open/manyfold/pull/336) [`c532eb3`](https://github.com/manyfold-open/manyfold/commit/c532eb3b60bd6d140aeb54ba4fbf11d48143d1db) Thanks [@yingca1](https://github.com/yingca1)! - Retire the remaining internal peer credential mirrors and their shared hash
  records after every API instance uses the canonical policy writer. Remove the
  temporary revocation bridge. External A2A credentials, personal API tokens and
  runtime identities are preserved; peer policy and public grant IDs remain.

    The migration refuses unmigrated or recently used caller-bound credentials.
    Rollback after this contract must use the canonical writer, not the older
    mirror-writing preparation release.

### Patch Changes

- [#334](https://github.com/manyfold-open/manyfold/pull/334) [`b6d67ed`](https://github.com/manyfold-open/manyfold/commit/b6d67ed2424d073fab956c43e0b77633326b00eb) Thanks [@yingca1](https://github.com/yingca1)! - Keep failures from daemon WebSocket frame handling and connection cleanup
  inside their connection boundary. A failed presence update or malformed frame
  closes the affected connection for retry instead of escaping as an unhandled
  rejection. Cleanup failures are recorded without terminating the API process.

## 3.0.0

### Major Changes

- [#326](https://github.com/manyfold-open/manyfold/pull/326) [`6e8ebb9`](https://github.com/manyfold-open/manyfold/commit/6e8ebb9ba5d21bf2b6c2b954ac71364197ec1113) Thanks [@yingca1](https://github.com/yingca1)! - Internal A2A grants now write only the policy table. Remove the fake credential
  hash generator, mirror mutations and caller-bound database bearer path. New
  grants use their own IDs; existing public IDs continue to work. External A2A
  credentials retain their target-bound storage and behavior.

    Deploy the prior authority preparation release to every API instance first.
    This migration removes its ID alignment trigger. Mirror data and the remaining
    revocation bridge are cleaned up only after every instance uses this writer.

### Patch Changes

- [#319](https://github.com/manyfold-open/manyfold/pull/319) [`b7b59f2`](https://github.com/manyfold-open/manyfold/commit/b7b59f24c68786370d8ecc34456921416e755156) Thanks [@yingca1](https://github.com/yingca1)! - Opening a Codex session right after a turn no longer appends the model's own preamble (`# AGENTS.md instructions for …` plus the environment context) to the chat as a user message, and no longer duplicates a reply whose turn ran a command. Each settled turn now records how far the runtime's transcript reached, and the runtime-session sync appends only what a terminal session added past that point, complete turns only, instead of diffing the transcript against the chat by content.

## 2.0.0

### Major Changes

- [#322](https://github.com/manyfold-open/manyfold/pull/322) [`a681865`](https://github.com/manyfold-open/manyfold/commit/a6818656b58ac333c45f46095453851944e2ba73) Thanks [@yingca1](https://github.com/yingca1)! - Use the dedicated A2A peer-grant table for authorization, caller lists and
  revocation. Reconcile previously revoked token mirrors that left policy active,
  backfill older grants and preserve existing public grant IDs. Temporary database
  compatibility triggers protect old writers during rolling deployment.

    Caller-bound long-lived A2A token creation now returns 410. Use the existing
    batch peer-grant endpoint and per-call peer tickets for internal agent access.
    External caller-less A2A credentials retain their single-target behavior.

    Deploy this preparation version to every API instance before stopping mirror
    writes and applying the final cleanup. The mirrors and compatibility triggers
    remain only for that deployment transition.

### Minor Changes

- [#323](https://github.com/manyfold-open/manyfold/pull/323) [`3eede59`](https://github.com/manyfold-open/manyfold/commit/3eede59bbfb385092e23bede3639732864a90e1e) Thanks [@yingca1](https://github.com/yingca1)! - Chat errors now include a server-classified cause used by the web workbench and
  terminal telemetry. Live events, replayed streams and historical messages use
  the same classification rules. The web no longer guesses authentication,
  billing or thread contention from error wording. Retryability remains the
  adapter's explicit decision.

## 1.1.0

### Minor Changes

- [#318](https://github.com/manyfold-open/manyfold/pull/318) [`a402b42`](https://github.com/manyfold-open/manyfold/commit/a402b42431c6b0d2093b43fff266e7461ca5f52d) Thanks [@yingca1](https://github.com/yingca1)! - Accept daemon WebSocket credentials in the Authorization header, with the
  header authoritative when both authentication forms are present. Deploy this
  API before updating daemons to the header-only client. Older query-authenticated
  clients remain supported during migration and their use is reported so operators
  can verify the fleet before retiring that reader.

    Scrub credentials before runner diagnostics reach console, OpenTelemetry or
    Sentry. This includes old runner log tails, encoded and repeated query tokens,
    headers, exception stacks and nested log values. HTTP spans omit standalone
    query attributes. Existing exposed daemon credentials still need rotation after
    the affected daemons have upgraded.

## 1.0.0

### Major Changes

- [#312](https://github.com/manyfold-open/manyfold/pull/312) [`540b929`](https://github.com/manyfold-open/manyfold/commit/540b929109ce074d666aa11e7e482477ce1fb9b3) Thanks [@yingca1](https://github.com/yingca1)! - Remove the retired k8s dashboard's `dashboardUrl` field from runtime summaries
  and the exported `AgentRuntimeSummary` type. The field always returned null;
  sprite dashboards continue to use the existing control-ui URL endpoint.

    All web sign-in methods now accept only internal redirect paths. Remove
    `VITE_DASHBOARD_ORIGIN_SUFFIXES` and `MF_SELFHOST_DASHBOARD_SUFFIXES` from build
    configuration; the retired dashboard redirect flow no longer uses them.

### Patch Changes

- [#314](https://github.com/manyfold-open/manyfold/pull/314) [`6afa649`](https://github.com/manyfold-open/manyfold/commit/6afa6490cc45ec2a17b1da73f7bee8e7896cc173) Thanks [@yingca1](https://github.com/yingca1)! - Managing added accounts on a sandbox runtime now wakes the sandbox and its runner instead of timing out against a frozen one. Adding, signing in, signing out and removing an account resume a sleeping sandbox on the user's behalf; a runtime whose sandbox has never run a turn, or whose runner is not answering, shows a "Start runner" action on the runtime page instead of a dead-end notice.

## 0.76.5

### Patch Changes

- [#308](https://github.com/manyfold-open/manyfold/pull/308) [`af33522`](https://github.com/manyfold-open/manyfold/commit/af33522185d93776f371d7fd92fad5f18150a9f6) Thanks [@yingca1](https://github.com/yingca1)! - Upgrading a sandbox's mf CLI now restarts the sprite runner onto the installed binary. The runner is a long-lived process with no supervisor, so it kept running — and reporting — the build it was started with: after an upgrade the sandbox showed the new version while the runtime page still asked for a CLI update, because every capability check reads the runner's own heartbeat. A runner with live exec or terminal sessions is left alone rather than interrupted; the outcome is logged either way.

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
  entirely — they stay, unchanged, for the one gateway framework that still uses them.

    `MF_OPENCLAW_ACP` is retired: it defaulted on and setting it now does nothing.
    `MF_OPENCLAW_TURN_RPC` is unchanged and still gates that framework's runner
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

- [#244](https://github.com/manyfold-open/manyfold/pull/244) [`e204c5f`](https://github.com/manyfold-open/manyfold/commit/e204c5f0f452d407e9722634a6e02bc2e8bf5494) Thanks [@yingca1](https://github.com/yingca1)! - Route openclaw chat over ACP by default. `MF_OPENCLAW_ACP` now defaults on, so sprite (no-runner) and k8s openclaw turns run the `openclaw acp` bridge — enabling per-message model switching and interactive permission approval — instead of the stateless gateway-http path. Set `MF_OPENCLAW_ACP=0` to fall back to gateway-http without a redeploy. Other gateway frameworks are unaffected (they keep the gateway-http path via the framework guard). The gateway-http chat branch is retained as that rollback for now and will be removed in a follow-up, once the gateway-http adapter split lands.

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

- [#207](https://github.com/manyfold-open/manyfold/pull/207) [`575b309`](https://github.com/manyfold-open/manyfold/commit/575b3094d06e2f1f585324668f89ad8ef9d13c1a) Thanks [@yingca1](https://github.com/yingca1)! - Add an API-driven ACP transport for openclaw chat turns on the sprites-no-runner and k8s cells, behind `MF_OPENCLAW_ACP` (default off). When enabled, the adapter drives `openclaw acp` — a bridge to the resident gateway — over the interactive exec transport using the shared `AcpTurn` client, replacing the stateless gateway-HTTP path (30-message resend) with the gateway's own server-side history keyed by a deterministic `_meta.sessionKey`. Other gateway frameworks keep the gateway-HTTP path (the ACP branch is guarded on `framework === 'openclaw'`). Non-resumable by construction; every failure is a retryable error, never suspended.

- [#207](https://github.com/manyfold-open/manyfold/pull/207) [`575b309`](https://github.com/manyfold-open/manyfold/commit/575b3094d06e2f1f585324668f89ad8ef9d13c1a) Thanks [@yingca1](https://github.com/yingca1)! - Add per-message model switching for openclaw agents in the chat composer, matching hermes. The model list comes from the agent's provider-models cache (openclaw joins the model-config provider-detail allowlist), and the pick is applied to the openclaw ACP turn via an in-box `openclaw gateway call sessions.patch {model}` in the exec wrapper — probe-verified to change a live session's model from the next prompt, stick to the gateway session key, and route through to the provider even for models not pre-registered in the gateway config (so no catalog registration is needed). Behind `MF_OPENCLAW_ACP`; other frameworks are unaffected.

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
