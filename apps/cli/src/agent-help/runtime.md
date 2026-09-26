# mf runtime — agent guide

## Purpose

Manage agent runtimes — the sprite or k8s pod shell that hosts framework
agents. `mf runtime` (alias `mf agent-runtimes`) covers runtime lifecycle
(`list`, `get`, `delete`), the control UI and Hermes dashboard sidecars,
and the framework agents hosted on a runtime (`agents add|list|remove`).

## Required scopes

{{CALLER_CONTEXT}}

> Required **only for `--account`** (account-wide) actions. Operating your
> **own** agent's runtime (the default) needs no permission.

- `agent-runtimes:read` — `list`, `get`, `control-ui get-url`
- `agent-runtimes:edit` — `delete`, `control-ui enable|disable`, `dashboard enable|disable`
- `agents:read` — `agents list`
- `agents:edit` — `agents add`, `agents remove`

For a scope denial, follow `mf help auth --agent` for the current identity.

## Common commands

```sh
mf runtime list                                    # alias: ls
mf runtime get <runtime-id>
mf runtime delete <runtime-id>                     # destroys the sprite/pod, cascades to hosted agents
mf runtime control-ui get-url <runtime-id> --json  # also: control-ui enable|disable <runtime-id>
mf runtime dashboard enable <runtime-id>           # Hermes only; also: dashboard disable
mf runtime agents add <runtime-id> --name <name> --json
mf runtime agents list <runtime-id> --json
mf runtime agents remove <agent-id> --yes          # agent id, NOT runtime id
```

`agents add` also accepts `--workspace <path>` (coding agents only),
`--model <model>`, and `--clone-from <agent-id>`.

## Output

- Human output is one line per item:
  `<id>  <name>  <framework>/<kind>  <status>  agents=<n>`; `get` adds
  sprite/namespace/ingress/created detail lines when present.
- `--json` (raw JSON) exists on every subcommand: `list`/`get` emit the
  runtime object(s); `delete` and `agents remove` emit `{ ok, id }`;
  `control-ui`, `dashboard`, and `agents add`/`list` emit their result.
- Empty results print `(no agent runtimes)`, `(no framework agents)`, or
  `(no control UI url)` — these are not errors.
- Runtime output contains no secrets or tokens.

## Failure recovery

- "not authenticated" → `mf help auth --agent`
{{AUTH_RECOVERY}}
- `404` "agent runtime … not found" → wrong id (or not your runtime);
  re-check with `mf runtime list`
- `agents remove` refuses without `--yes` → re-run with `-y` after
  confirming the agent id
- `409` on `agents list` → that runtime's framework does not support
  live agent listing
- `dashboard enable` rejected → the dashboard sidecar is Hermes-only
