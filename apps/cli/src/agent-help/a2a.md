# mf a2a — agent guide

## Purpose

Talk to other agents over the A2A (Agent2Agent) protocol — either a
**granted peer** (another Manyfold agent the user lets you call) or any
**raw A2A server** by URL. The client speaks A2A **v0.3** over JSON-RPC.

A `<target>` is resolved automatically:

- a **peer name or agent id** (from `mf a2a status`) → resolved live from
  the platform using this agent's own login token; a short-lived bearer is
  minted per call, so you never handle a URL or token. Needs the
  `a2a:read` scope. With a **user token** (`mf login`, not an agent
  runtime), pick which of your agents to act as via the global
  `--agent-id <id>` (or `$MF_AGENT_ID`): `mf --agent-id <id> a2a status`.
- an **http(s) URL** → used as a raw A2A server. A base URL discovers the
  card at `/.well-known/agent-card.json`; a `.json` card URL is fetched; a
  `/rpc` or `/a2a` URL is used as-is. Auth via `--bearer` / `$MF_A2A_BEARER`.
  Needs no Manyfold account.

## Commands

```sh
mf a2a status                              # peers you may call + in-flight calls
mf a2a exposure get                        # show hosted A2A state + endpoints
mf a2a exposure enable                     # publish this agent as an A2A server
mf a2a exposure disable                    # stop publishing this agent
mf a2a callers list                        # callers allowed to invoke this agent
mf a2a callers add --external --name ci    # mint a one-time external bearer
mf a2a callers add --caller-agent-id <id>  # authorize a Manyfold peer
mf a2a callers revoke <tokenId> --yes      # revoke an external or peer grant
mf a2a send <target> "<prompt>"            # send a message, wait for the result
mf a2a send <target> "<prompt>" --async    # submit, return a task id, don't block
mf a2a send <target> "<prompt>" --stream   # stream status + artifact chunks (SSE)
mf a2a tasks list                          # your outbound calls and their state
mf a2a tasks get <target> <taskId>         # fetch a task (add --wait to poll)
mf a2a tasks cancel <target> <taskId>      # cancel a running task
mf a2a tasks subscribe <target> <taskId>   # reconnect to a task's SSE stream
mf a2a card <url>                          # print an Agent Card
```

- `mf a2a status` lists the peers you may call (name + agent id), fetched
  live each run — a newly granted peer appears immediately, no restart. It
  also shows your in-flight outbound calls. If it lists no peers, you have
  no grants yet: ask the user to grant one from the target agent's A2A tab.
  `--json` emits `{ peers, inflight }` (no tokens).
- `mf a2a send` delegates a subtask and prints the peer's final answer to
  stdout. The peer runs in its own workspace, billed to its own owner, and
  cannot read your workspace.

## Manage this agent's A2A server

Exposure and callers are separate controls. Adding a caller does **not**
enable exposure; run both commands when publishing an agent for the first
time:

```sh
mf a2a exposure enable
mf a2a callers add --external --name build-system
```

`exposure get|enable|disable` reports the public Agent Card and JSON-RPC
URLs. `callers list` shows every non-revoked peer and External client
grant, including expired grants. Read operations need `a2a:read`; changing
exposure or callers needs `a2a:edit`. If a runtime token lacks a scope,
request it with `mf auth ensure --scopes a2a:read` or
`mf auth ensure --scopes a2a:edit`.

`callers add` requires exactly one mode:

- `--external [--name <name>] [--expires-in-days <positive-int>]` creates
  a bearer for a non-Manyfold client. In human mode the new token is the
  only stdout line; copy it directly to secure storage. The warning,
  token id, expiry, Card URL, and RPC URL go to stderr. `--json` returns
  the full object including the one-time token. The CLI never saves it and
  cannot display it again.
- `--caller-agent-id <id> [--expires-in-days <positive-int>]
[--replace-existing]` grants one Manyfold peer. It returns only grant
  metadata and never exposes the internal bearer.

Use `mf a2a callers revoke <tokenId> --yes` to revoke either kind. Every
leaf command supports `--json`.

## Long tasks: submit async, fetch later

A blocking `send` holds the call open until the peer finishes, and the
hosted server caps a blocking turn short (default **10 minutes**). For a
long task prefer `--async`: it returns a **task id** immediately, the work
survives even if your sandbox sleeps while the peer runs, and the server
applies its much longer async cap (default **2 hours**; operators can tune
both caps). Async is **not unbounded**: past the cap the task fails with
`turn_timeout` and the peer's turn is cancelled — whatever it produced by
then is visible via `mf a2a tasks get`. Split work that may exceed the cap
into smaller delegations.

```sh
id=$(mf a2a send <peer> "<long task>" --async)   # prints the task id to stdout
mf a2a tasks list --state working                # see what's still running
mf a2a tasks get <peer> "$id" --wait             # block until done, print result
```

The result is stored durably on the platform and fetched on demand — **do
not** redirect call output to `/tmp` to keep it; `/tmp` is wiped when the
sandbox hibernates. `tasks get`/`cancel`/`subscribe` take the same
`<target>` you sent to (peer name/id, or url for a raw server).

To continue the same conversation, pass the `context <id>` printed in the
task summary back via `--context-id <id>`; without it each call is a fresh
session with no memory of earlier calls.

## Shared options

- `--bearer <token>` — bearer auth for a raw **url** target (ignored for a
  peer, which mints its own). `"-"` reads stdin; else `$MF_A2A_BEARER` is
  the fallback. Never printed, including on error.
- `--json` — emit raw A2A `Task` / `Message` / stream-event JSON.
- `--allow-http-localhost` — permit `http://` and localhost/private targets
  (local dev only; HTTPS public hosts only by default — SSRF guard).
- `--timeout <seconds>` — client deadline for `send` and `tasks get --wait`
  (`0` disables; default 900). The hosted server enforces its own per-turn
  caps (blocking vs async, see "Long tasks"); this is the client-side
  backstop so the CLI never hangs forever. The 900s default comfortably
  covers the default 600s blocking cap — raise it if the operator raised
  the blocking cap.
- `send` also accepts `--context-id <id>`, `--task-id <id>`, `--skill <id>`,
  and `--input-file <path>` (attached as an A2A file part).

## Output

Human mode writes artifact text to stdout and status/task summaries to
stderr, so stdout stays a clean, pipeable artifact (with `--async`, stdout
is just the task id). `--json` writes raw protocol JSON. Errors print to
stderr as `cli Error: …` and exit 1; tokens are never included.

## Failure recovery

- `no granted peer matching "…"` → run `mf a2a status` to see exact names;
  ask the user to grant the peer if missing.
- `no usable A2A token` / `a2a:read` missing → run
  `mf auth ensure --scopes a2a:read`, post the consent URL to the user
  (existing permissions are kept), retry after they approve.
- `a2a:edit` missing while changing exposure/callers → run
  `mf auth ensure --scopes a2a:edit` and retry after approval.
- `needs an agent context` (user token) → add `--agent-id <id>` for an agent
  you own, e.g. `mf --agent-id <id> a2a status`.
- `too many concurrent A2A delegations` → you have hit the in-flight cap;
  wait for one to finish (`mf a2a tasks list --state working`) and retry.
- `-32001 Task not found` on `tasks get|cancel|subscribe` → the task id is
  unknown to that target or not visible to your credential.
- `unsupported A2A protocolVersion` / `exposes no JSONRPC interface` → a raw
  server speaks something this client does not (only v0.x JSON-RPC).
- `… host … is not allowed` / `private or reserved address` → the url is
  localhost/private; pass `--allow-http-localhost` for local dev.
- `401` / `403` on a url target → provide or fix `--bearer`
  (or `$MF_A2A_BEARER`).
