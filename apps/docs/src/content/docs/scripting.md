---
title: Scripting with mf
description: Use JSON output, stable exit codes, profiles, and safe credentials in scripts and CI.
order: 4
---
The CLI separates machine-readable payloads from human diagnostics so scripts
can handle both success and failure reliably.

## Select context explicitly

Pin the profile and agent in unattended jobs:

```sh
export MF_PROFILE=default
export MF_AGENT_ID=agt_xxx
mf whoami --json
```

Use `--account` only when the job deliberately needs account-wide access. An
agent identity can work on its own resources without a grant; another agent or
the whole account may require a user-approved scope.

## JSON output

Data and mutation commands normally accept `--json`:

```sh
mf agent list --json | jq -r '.[].id'
mf automations get aut_xxx --json > automation.json
```

On success, stdout contains only the raw JSON payload, formatted with two-space
indentation. Human progress belongs on stderr. Channel and credential output
remains redacted; `mf login --json` never prints the bearer token.

Without `--json`, list commands print a table with a header row. The table is
for people and its columns may change; scripts should use `--json`.

On failure, stderr contains:

```json
{
    "error": {
        "code": "not_found",
        "status": 404,
        "message": "…",
        "hint": "…"
    }
}
```

`status` and `hint` appear only when available. The CLI never includes an
unparsed response body in the error envelope.

A plan limit or quota (`CHANNEL_LIMIT_REACHED`, `ACTIVE_HOURS_QUOTA_REACHED`
and the other `*_LIMIT_REACHED` / `*_QUOTA_REACHED` codes) also carries
`details` with `current`, `limit` and `planName`. It exits `3` like any `403`,
and its `hint` says what to free up.

## Exit codes

| Code | Meaning                                       |
| ---- | --------------------------------------------- |
| `0`  | Success                                       |
| `1`  | Other server or runtime failure               |
| `2`  | Network failure or timeout                    |
| `3`  | Authentication or authorization (`401`/`403`) |
| `4`  | Resource not found (`404`)                    |
| `5`  | Invalid CLI usage or request (`400`/`422`)    |

Branch on the exit code, then parse stderr when you need details:

```sh
if result="$(mf agent get agt_xxx --json 2>mf-error.json)"; then
  printf '%s\n' "$result"
else
  code=$?
  jq '.error' mf-error.json >&2
  exit "$code"
fi
```

Commands that run a check are the exception: `mf doctor`,
`mf model-providers test`, `mf channels test` and `mf channels register` exit
`1` when the check fails, but their report still goes to stdout and stderr
stays empty. Read the report's `ok` (and, from `mf doctor --json`, each
check's `status`). `mf updates apply` likewise exits `1` when any update
failed, with every result on stdout. `mf updates list` exits `0` even when
one of the lists it joins did not load; that list is in `errors`.

## Commands without JSON mode

These commands intentionally use a raw stream, interactive flow, or long-lived
process instead of JSON:

- `mf files read`
- `mf daemon logs`
- `mf daemon start`
- `mf daemon register`
- `mf daemon stop`
- `mf setup`
- `mf update`

Confirm the installed version with `mf <command> --help`.

## Credentials

Prefer a saved profile for long-lived hosts. For ephemeral CI, provide a token
through a protected environment variable or stdin:

```sh
printf '%s' "$MF_CI_TOKEN" |
  mf --api-url https://api.manyfold.ai/api --token - whoami --json
```

> **Warning:** Avoid a literal `--token <value>` because arguments may appear
> in shell history and process listings. Never log `MF_TOKEN`, `MF_API_TOKEN`,
> an agent credential reveal, or files below `~/.manyfold/profiles/<name>/`.

## Timeouts and version drift

`MF_HTTP_TIMEOUT` controls ordinary API requests. A plain number means seconds;
duration suffixes `ms`, `s`, `m`, and `h` are accepted. Any other value stops
the command with an error before it sends a request.

Use `mf --version` in diagnostic output and validate syntax against the
installed binary:

```sh
mf --version
mf automations create --help
```

## See also

- [Profiles and environments](/docs/profiles/)
- [CLI command reference](/docs/cli/reference/)
- [Manyfold CLI](/docs/cli/)
