# Manyfold CLI (`mf`) — agent guide

You are an agent running in a Manyfold-managed runtime. The `mf` CLI acts
on the Manyfold platform on the user's behalf. These env vars are set:

- `MF_API_URL` — Manyfold API base (already includes the `/api` prefix)
- `MF_AGENT_ID` — your agent id
- `MF_DEPLOY_ENV` — Manyfold deployment environment (`staging` |
  `production` | `local`); may be absent on older runtimes

## Quickstart: you are already authenticated

The runtime injects your agent identity token (`MF_API_TOKEN`) and `mf`
reads it automatically — you do not log in for identity. If a command
fails because your identity lacks a scope:

```sh
mf auth ensure --scopes channels:read,channels:edit
```

Request **only the scope you are missing** (existing permissions are
KEPT — approval appends). The CLI prints a consent URL — **post exactly
that URL to the user** and ask them to approve. Never paste any token in
chat. The command exits after printing the URL; once the user approves,
just retry — the platform reads the added scope live. Details:
`mf help auth --agent`.

## Scope: your agent vs the whole account

By default every command is scoped to **your own agent** (`$MF_AGENT_ID`) and
needs **no permission** — list, read and manage your own automations, files,
channels, skills, backups, chat, terminal and runtime freely.

To reach the **whole account** — another agent's resources, or account-level
resources (all agents, model providers, account usage) — add `--account`:

```sh
mf automations list --account                       # across ALL your agents
mf automations list --account --agent-id agt_other  # a specific other agent
mf agent list --account                             # every agent on the account
```

`--account` requires a user-granted scope (e.g. `automations:read`). If your
identity lacks it, the command prints a **consent URL** — post it to the user
to approve, then retry. Targeting another agent **without** `--account` → `403`.

## Topics

{{TOPIC_LIST}}

Add `--json` to any `mf help … --agent` call for a machine-readable
envelope (`topic`, `cliVersion`, `topics`, `content`). Most commands also
accept `--json`; with it, the result is raw JSON on stdout and a failure is
emitted as `{ "error": { "code", "status"?, "message", "hint"? } }` on
stderr (never the raw response body), so both success and failure stay
parseable. Exit codes are stable in every mode: 2 network failure, 3 auth
(401/403), 4 not found, 5 invalid usage or arguments (400/422), 1 anything
else. `mf <command> --help` shows human-readable flags.

## Failure recovery

- "not authenticated" → the runtime should already hold `MF_API_TOKEN`;
  if it is genuinely missing, tell the user (`mf help auth --agent`)
- `401` / missing scope → only `--account` (account-wide) actions need a
  scope; your own-agent actions are free. Request just that scope (existing
  ones are KEPT): `mf auth ensure --scopes <missing scope>`, then retry
- `403` → you targeted a different agent without `--account`; act on
  `$MF_AGENT_ID`, or add `--account` for account-wide access (needs a grant)
- unknown flag or command → `mf <command> --help`

## Available grant scopes

{{GRANTABLE_SCOPES}}

## Safety (always applies)

- Never print `~/.manyfold/profiles/<name>/config.json`, any file below a
  profile's `daemon/` directory, or any token value.
- Only share the consent URL with the user — the URL alone is safe.
- Request the minimum scopes the task needs.
- Full rules: `mf help safety --agent`
