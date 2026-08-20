# mf model-config — agent guide

## Purpose

Read and change which model (and model settings) an agent runs.
`mf model-config` and `mf agent model-config` are the same commands —
use either. Agent ids come from `$MF_AGENT_ID` or `mf agent list`.

## Required scopes

> Required **only for `--account`** (account-wide) actions, e.g. another
> agent's config. Reading or updating your **own** agent's model config (the
> default) needs no permission.

- `model-config:read` — needed for `get` (view agent model configuration)
- `model-config:edit` — needed for `update` and `refresh-models`
  (changes which model the agent runs; may change cost)

Missing a scope? `mf auth ensure --scopes <missing>` — see `mf help auth --agent`.

## Common commands

```sh
mf model-config get $MF_AGENT_ID
mf model-config update $MF_AGENT_ID --model <model-id> --json
mf model-config update $MF_AGENT_ID --source <platform|runtime-local>
mf model-config update $MF_AGENT_ID --config '<json-object>' --json
mf model-config update $MF_AGENT_ID --config @<file.json>
mf model-config update $MF_AGENT_ID --clear-model --clear-config
mf model-config refresh-models $MF_AGENT_ID --json
```

`update` requires at least one of `--source` / `--model` /
`--clear-model` / `--config` / `--clear-config`. `--config` takes a
framework-shaped JSON object (claude-code: `model`, `effort`,
`modelMap`; codex: `model`, `speed`, `intelligence`; gemini-cli:
`model`). Pick `--model` values from the `options` array in `get`
output — only entries with `enabled: true` are valid.

## Output

- `get` always prints the raw JSON view: `source`, `availableSources`,
  `provider`, `providerModels`, `config`, `options`, `validation`.
- `update` and `refresh-models` print a one-line summary by default;
  add `--json` for the full JSON result.
- `refresh-models --json` returns `ok`, `models`, `latencyMs`,
  `message` and the updated `view`.
- No secrets appear in any output; provider API keys are never included.

## Failure recovery

- "not authenticated" → `mf help auth --agent`
- `401` → missing scope; request just that scope (existing ones are
  kept): `mf auth ensure --scopes <missing scope>`, then retry
- `403` → the action targets a different agent than your identity; act on
  `$MF_AGENT_ID`
- "nothing to update" → pass at least one `update` flag (list above)
- `validation.valid: false` in `get` output → read
  `validation.messages`; often fixed by `refresh-models` or by mapping
  models via `--config`
- `refresh-models` prints `failed` plus a message → provider
  unreachable or source unsupported; check `availableSources` in `get`
