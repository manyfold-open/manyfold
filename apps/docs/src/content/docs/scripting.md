---
title: Scripting with mf
description: Use JSON output, stable exit codes, profiles, and safe credentials in scripts and CI.
order: 4
---

# Scripting with mf

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

Avoid a literal `--token <value>` because arguments may appear in shell
history and process listings. Never log `MF_TOKEN`, `MF_API_TOKEN`, an agent
credential reveal, or files below `~/.manyfold/profiles/<name>/`.

## Timeouts and version drift

`MF_HTTP_TIMEOUT` controls ordinary API requests. A plain number means seconds;
duration suffixes `ms`, `s`, `m`, and `h` are accepted.

Use `mf --version` in diagnostic output and validate syntax against the
installed binary:

```sh
mf --version
mf automations create --help
```

## See also

- [Profiles and environments](../profiles/)
- [CLI command reference](../cli-reference/)
- [Manyfold CLI](../cli/)
