# mf model-providers — agent guide

## Purpose

List and re-test the model providers this account can create agents
with: saved ones (the user's own keys, added in the web app under
Settings → Model providers) and Manyfold managed ones.
`mf agent create --model-provider` takes an id or name from this list,
or `managed` / `subscription`.

## Required scopes

{{CALLER_CONTEXT}}

- `model-providers:read` — `list`, `test`

For a scope denial, follow `mf help auth --agent` for the current identity.

## Common commands

```sh
mf model-providers list
mf model-providers list --framework claude-code --json
mf model-providers test <provider-id|name> --framework claude-code
```

With `--framework`, each provider says whether it can serve that framework
(`usable`, `untested`, `incompatible`) and which tested models `--model`
accepts from it, grouped by family for claude-code: an alias such as
`sonnet → claude-sonnet-5` follows the family's newest tested model, an id
pins one. `managed` names the row `--model-provider managed` picks.

`test` asks the provider for its models again and saves what it answers.
That is how a model released since the last test, or a provider never
tested, becomes something `--model` takes. It exits 1 when the test fails
(`result.status`, `result.message`). Adding and deleting providers is only
possible in the web app.

## Output

- Human output: one line per provider, `id  name  managed|saved  status`,
  then its models when usable.
- `--json`: `{ framework, managed, providers }`; with `--framework` each
  provider also carries `verdict` and `models`, each model an object
  `{ value, label, providerModel, family, alias }` (`models` is null for
  antigravity-cli, which takes its own model names). Keys appear only
  masked (`apiKeyMasked`).
- `test --json`: `{ provider, result, framework, models }`, where `result`
  is `{ ok, status, message?, latencyMs, models }` as the provider answered.

## Failure recovery

- "not authenticated" → `mf help auth --agent`
{{AUTH_RECOVERY}}
- No usable provider → create with `--model-provider managed` or
  `subscription`, test an untested one with `mf model-providers test`, or
  ask the user to add one in the web app
