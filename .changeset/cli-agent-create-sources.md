---
'@manyfold/cli': minor
---

Creating an agent from the CLI now chooses its model and its sandbox the way the web app does:

- `--model-provider managed | subscription | <provider id or name>` binds the agent to Manyfold managed models, to the user's own subscription (signed in on the sandbox afterwards; the output prints the sign-in command and the chat link), or to a saved provider. `--model` picks one of the provider's tested models and is checked before anything is created.
- `--sandbox <id|name>` adds the agent to a sandbox the account already has instead of creating one; where the framework already runs there, the agent uses its credentials. `mf sandbox list` and `mf sandbox delete` show and free sandboxes, and `mf model-providers list [--framework]` shows which providers can serve a framework and with which models.
- Key flags take `-` to read the key from stdin.
- Progress names each step and how long it took. A dropped connection is picked up again, and after Ctrl-C (exit 130) running the same command again attaches to the create instead of starting another.
- Failures a script can act on come with a hint for what to do next and, in `--json` output, their `details` (for example `RUNTIME_LIMIT_REACHED` with the plan's limit).

Breaking changes:

- `mf agent create` no longer reads keys, base URLs or models from environment variables (`ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `PI_API_KEY` and the like). Pass the key flag, with `-` to read it from stdin. A create that names no model source is a usage error (exit 5) listing the choices.
- `--provider-id` is now `--runtime-provider`, and `--model` replaces `--gemini-model`, `--pi-model` and `--agy-model`.
