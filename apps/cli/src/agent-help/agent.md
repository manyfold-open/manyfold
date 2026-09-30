# mf agent — agent guide

## Purpose

CRUD, storage, and credential management for Manyfold agents
(alias: `mf agents`). In a managed runtime, your agent id is `$MF_AGENT_ID`. Model
settings are also reachable as `mf agent model-config …` but are
documented in `mf help model-config --agent`.

## Required scopes

{{CALLER_CONTEXT}}

> Required **only for `--account`** (account-wide) actions — e.g. `list`ing
> every agent, `create`, or acting on another agent. Operating your **own**
> agent (the default) needs no permission.

- `agents:read` — `list`, `get`, `storage-usage`
- `agents:edit` — `create`, `update`, `delete`
- `create` also reads what it names: `model-providers:read` for a
  `--model-provider` other than `subscription`, `sandboxes:read` and
  `agent-runtimes:read` for `--sandbox`
- `secrets:read` — `credentials get`, `credentials reveal`
- `secrets:edit` — `credentials update`
- `chat:edit` — `send`, `chat`; `chat:read` for the reply and
  `--continue`; `files:edit` for `--file`

For a scope denial, follow `mf help auth --agent` for the current identity.

## Common commands

```sh
mf agent list
mf agent get <agent-id> --json
mf agent create <name> --framework codex --model-provider managed --json
mf agent update <agent-id> --name <new-name> --json
mf agent send <agent-id> "<message>"
mf agent delete <agent-id> --yes
mf agent storage-usage <agent-id>
mf agent credentials reveal <agent-id>
mf agent credentials update <agent-id> --body '<json-or-@file>'
```

- `update` needs at least one of `--name`, `--model`, `--clear-model`.
  `--model` takes the names `create --model` takes. A coding agent keeps
  its model in its model settings, so for one the change goes there, as
  `mf model-config update --model` makes it; a model those settings do not
  offer is a usage error that lists the ones they do. The new model runs
  from the next turn of every session, sessions already open included.
- `delete` (alias `rm`) is irreversible and refuses without `--yes`/`-y`.

## Creating an agent

`create` makes a coding agent — `--framework` `claude-code` (default) |
`codex` | `gemini-cli` | `pi` | `antigravity-cli` — on a new sandbox, or
adds it to one the account has with `--sandbox <id|name>`
(`mf sandbox list`). A new sandbox counts against the plan's sandboxes.

A new sandbox needs exactly one model source:

- `--model-provider managed` — Manyfold managed models.
- `--model-provider subscription` — the user's own subscription, signed in
  on the sandbox after the create. The output prints the sign-in command
  and the chat link whose sign-in card walks through it.
- `--model-provider <id|name>` — a saved provider from
  `mf model-providers list --framework <fw>`; it must have been tested.
- The framework's key flag: `--anthropic-auth-token`, `--openai-api-key`,
  `--google-api-key` (gemini-cli, antigravity-cli) or `--pi-api-key` with
  `--pi-provider anthropic|openai|google`. Pass `-` and pipe the key in, as
  below; a key in argv lands in shell history. Environment variables are
  not read.

```sh
printenv OPENAI_API_KEY | mf agent create reviewer --framework codex --openai-api-key -
```

`--model` picks one of the provider's tested models, listed by
`mf model-providers list --framework <fw>`. For claude-code an alias
(`sonnet`, `opus`, `sonnet[1m]`, …) follows its family's newest tested
model, and an id pins one. The id an alias stands for is saved as that
alias. A name as people write it (`Sonnet 5`, `sonnet 4.5`) resolves when
it matches exactly one model. A model the provider was not tested with is
a usage error that lists what it can run; a model released since its
last test needs `mf model-providers test <provider>` first. With a pasted
key `--model` applies to gemini-cli, pi and antigravity-cli only.

On `--sandbox` where the framework already runs, the agent shares that
instance's credentials with every agent on it: pass no model source (or
`--model-provider subscription` to use the sandbox's own sign-in). Where
it does not run yet, the create installs it there and needs a model
source as above.

Progress goes to stderr, one line per finished step. If the connection
drops, `create` picks the running create up again on its own. After a
Ctrl-C (exit 130) the create goes on on the server: running the same
command again attaches to it, or returns the agent it made.

## Talking to an agent

`send` sends one message and prints the reply:

```sh
mf agent send <agent-id> "summarise the open PRs"
git diff | mf agent send <agent-id> -
mf agent send <agent-id> -c "and the failing test?"
mf agent send <agent-id> "what is in it?" --file ./screenshot.png
```

- A new session each time, unless `--session <id>` names one or `-c`
  continues the one last active (sessions a channel drives are left out).
  The footer on stderr names the session and how to go on in it.
- The message comes from the arguments, or from stdin for `-` (and when
  there are no arguments and stdin is a pipe).
- The agent's saved model and permission settings apply; nothing is saved.
- `--file` (repeatable) uploads a local file to `chat-attachments/<session>/`
  in the agent's workspace and attaches it; the agent reads it there,
  images included. At most 10 files, 25 MiB each, 100 MiB together.
- The reply goes to stdout, streamed on a terminal and whole when piped;
  tool calls and the footer (model, tokens, cost, time) go to stderr.
  `--json` prints one object: `sessionId`, `userMessageId`,
  `assistantMessageId`, `text`, `usage`, `error`.
- Exit codes: 0 when the turn ends, 1 when it fails (its error is printed),
  130 after Ctrl-C, which stops the turn on the server (a second Ctrl-C
  leaves at once). A dropped stream is picked up again; when it cannot be,
  the turn goes on on the server and the chat link says where to follow it.

`chat` is the same conversation at a prompt in a terminal:
`mf agent chat <agent-id> [--session <id> | -c] [--file <path>]`, one
message per line. `--file` (a file or an image, repeatable) goes with the
first message, as context for the chat; files it cannot upload wait for
the next one. `/new` starts a new session, `/exit` or Ctrl-D leaves; any other line
(slash commands included) goes to the agent. Ctrl-C during a reply stops
the turn; at the prompt it leaves. It needs a terminal: from a script,
use `send`.

## Output

- `list` / `get` / `update` print one line per agent:
  `id  name  framework/runtime  status`; `update` adds `model  <model>`
  when it changed the model. All accept `--json` (the
  scoped `{ scope, agents }` result for `list`, the full record otherwise);
  `delete` emits `{ ok, id }`. The list scope is `agent` or `account`.
- `create --json` prints the agent record plus `create`: `resumed`
  (this run picked up a create already under way), `sandbox`
  (`id`, `name`, `created`), `modelSource`, `chatUrl` and
  `signInCommand` (for a subscription still to be signed in).
- Agent records expose `workspaceBytes` and `workspaceMeasuredAt`, never the
  old mixed-unit `storageBytes`. Unknown historical readings are null. These
  values describe an agent's workspace, not its sandbox or the whole account.
  Use `mf sandbox storage-usage --account --json` for account storage totals.
- `storage-usage` and `credentials get` always emit pretty-printed JSON
  (`--json` accepted but already the default).
- `storage-usage` states `scope: "agent-paths"`; a sandbox agent's paths come
  from the sandbox's last storage measurement (`measuredAt`), while
  `cachedSandbox` carries the separate cached filesystem reading. See
  `mf help sandbox --agent` for storage units, freshness and attribution.
- `credentials reveal` masks the apiKey (first 4 + last 4 chars) unless
  `--show` is passed; never paste a revealed value into chat. `--json`
  is available.

## Failure recovery

- "not authenticated" → `mf help auth --agent`
{{AUTH_RECOVERY}}
- `create` exits 5 with "say who serves …'s model" → add one of the model
  sources it lists
- `RUNTIME_LIMIT_REACHED` → every sandbox the plan includes is in use: add
  the agent to one with `--sandbox`, or free one with `mf sandbox delete`
- `AGENT_NAME_TAKEN` (`details.agentId`) → pick another name
- `AGENT_CREATE_IN_PROGRESS` → a create of that name with other settings is
  under way; wait, or pick another name
- `AGENT_CREATE_INTERRUPTED` → the API restarted mid-create; run it again
  (`details.hostId` names a sandbox it may have left)
- `SANDBOX_API_UNREACHABLE` → the API's address (`details.apiUrl`) cannot
  be reached from a sandbox, so no sandbox was made: whoever runs the API
  sets `PUBLIC_API_BASE_URL` to a public address (a tunnel URL for a local
  stack)
- `SANDBOX_RUNNER_NOT_CONNECTED` → the runner inside the new sandbox (not a
  daemon on this computer) could not reach `details.apiUrl`; the sandbox
  was removed. Check that the address is reachable, then run it again
- `send`: "A turn is still running in this session" (409) → wait for it,
  or start a new session (leave out `--session` / `-c`);
  `session_held_by_terminal` → the session is open in a terminal: close it
  there, or start a new session
- "nothing to update" → pass at least one update flag (see above)
- "refusing to delete … without --yes" → add `--yes` only after the
  user confirms the deletion
