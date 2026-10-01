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
grant, including expired grants, as a table (`TOKEN ID KIND CALLER
EXPIRES`); the token id is what `callers revoke` takes. Read operations need `a2a:read`; changing
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

A blocking `send` holds the call open while the peer works, but the hosted
server holds it only up to its blocking cap (default **10 minutes**). A turn
still running then keeps running: the server hands the task back as
`working`, and `send` follows it with `tasks get` until it finishes, within
the same `--timeout`. If `--timeout` passes first, `send` exits 1 with the
task id and the `mf a2a tasks get … --wait` command that keeps following it.
For a task you expect to be long, prefer `--async`: it returns a **task id**
immediately, the work survives even if your sandbox sleeps while the peer
runs, and nothing waits on the call. Either way the task is **not
unbounded**: past the async cap (default **2 hours**; operators can tune both
caps) it fails with `turn_timeout` and the peer's turn is stopped. Split work
that may exceed it into smaller delegations.

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
- `--timeout <seconds>` — client deadline for `send` (including following a
  task the server handed back `working`) and `tasks get --wait` (`0`
  disables; default 900). It is the client-side backstop so the CLI never
  hangs forever; the server's own caps still apply (see "Long tasks").
- `send` also accepts `--context-id <id>`, `--task-id <id>`, `--skill <id>`,
  and `--input-file <path>`: the file goes as an A2A file part, and a
  Manyfold peer gets it in its workspace like a chat upload. The peer takes
  what the chat composer takes (text, code, images, PDF, Office documents;
  name the file with its extension), up to 25 MB.

## Output

Human mode writes artifact text to stdout and status/task summaries to
stderr, so stdout stays a clean, pipeable artifact (with `--async`, stdout
is just the task id). `--json` writes raw protocol JSON. `tasks list`
prints a table (`ID PEER STATE CREATED`), and `status` prints its peers
(`NAME AGENT ID`) and in-flight calls the same way. Errors print to
stderr as `cli Error: …` and exit by kind like every `mf` command (2 network,
3 auth, 4 not found, 5 usage, 1 otherwise); tokens are never included.

## Failure recovery

- `no granted peer matching "…"` (`a2a_peer_not_found`, exit 4) → run
  `mf a2a status` to see exact names; ask the user to grant the peer if
  missing.
- `already has an active A2A grant` (`a2a_grant_exists`, 409) on
  `callers add --caller-agent-id` → pass `--replace-existing`, or revoke the
  grant first (`mf a2a callers list` shows it).
- `A2A endpoint … could not be resolved` / `could not be reached` (exit 2) →
  check the URL and this machine's network; the error names the endpoint.
- `no usable A2A token` / `a2a:read` missing from a managed identity → run
  `mf auth ensure --scopes a2a:read`, post the consent URL to the user
  (existing permissions are kept), retry after they approve.
- `a2a:edit` missing from a managed identity while changing exposure/callers → run
  `mf auth ensure --scopes a2a:edit` and retry after approval.
{{AUTH_RECOVERY}}
- `needs an agent context` (user token) → add `--agent-id <id>` for an agent
  you own, e.g. `mf --agent-id <id> a2a status`.
- `too many concurrent A2A delegations` (`delegation_limit`) → you have hit
  the in-flight cap; wait for one to finish
  (`mf a2a tasks list --state working`) and retry.
- `-32001 Task not found` on `tasks get|cancel|subscribe` → the task id is
  unknown to that target or not visible to your credential.
- `timed out after …s; task … is still running on the peer` (exit 1) → the
  peer is still working; run the `track:` command it prints instead of
  sending again, which would start the same work twice.
- `delegated turn exceeded …s (detached cap)` (`turn_timeout`, exit 1) →
  the task ran past the async cap and the peer's turn was stopped; split the
  work into smaller delegations.
- `takes no files` / `is not a type this agent accepts` on `--input-file`
  → that peer cannot read this file: put its content in the prompt, or
  send a type the chat composer takes. `has no type` → give the file its
  extension (`notes` → `notes.txt`).
- `SANDBOX_CLI_TOO_OLD` on `--input-file` → the peer's sandbox runs a CLI
  too old to take files: update it as the hint says
  (`mf sandbox update <sandbox>`), or send without the file.
- `unsupported A2A protocolVersion` / `exposes no JSONRPC interface` → a raw
  server speaks something this client does not (only v0.x JSON-RPC).
- `… host … is not allowed` / `private or reserved address` → the url is
  localhost/private; pass `--allow-http-localhost` for local dev.
- `401` / `403` on a url target → provide or fix `--bearer`
  (or `$MF_A2A_BEARER`).
