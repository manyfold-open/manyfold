# mf model-providers — agent guide

## Purpose

List the model providers this account can create agents with: saved ones
(the user's own keys, added in the web app under Settings → Model
providers) and Manyfold managed ones. `mf agent create --model-provider`
takes an id or name from this list, or `managed` / `subscription`.

## Required scopes

{{CALLER_CONTEXT}}

- `model-providers:read` — `list`

For a scope denial, follow `mf help auth --agent` for the current identity.

## Common commands

```sh
mf model-providers list
mf model-providers list --framework claude-code --json
```

With `--framework`, each provider says whether it can serve that framework
(`usable`, `untested`, `incompatible`) and which tested models `--model`
accepts from it, and `managed` names the row `--model-provider managed`
picks. A provider that was never tested has no models to run: the user
tests it in the web app first. Adding, testing and deleting providers is
not available from the CLI.

## Output

- Human output: one line per provider, `id  name  managed|saved  status`,
  then its models when usable.
- `--json`: `{ framework, managed, providers }`; with `--framework` each
  provider also carries `verdict` and `models`. Keys appear only masked
  (`apiKeyMasked`).

## Failure recovery

- "not authenticated" → `mf help auth --agent`
{{AUTH_RECOVERY}}
- No usable provider → create with `--model-provider managed` or
  `subscription`, or ask the user to add and test one in the web app
