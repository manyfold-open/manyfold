---
version: '5.7.0'
date: '2026-09-30'
---

An agent can now be created, talked to and set up from the terminal the way
the web app does it. Creating an agent picks its model and its sandbox, a
conversation runs at the command line, automations take their schedule the
way you would say it, skills install by name or publish from a local
folder, and an agent's MCP servers are managed per scope.

`mf agent create --model-provider` binds the agent to Manyfold managed
models, to your own subscription or to a saved provider, `--model` picks one
of the provider's tested models, and `--sandbox` adds the agent to a sandbox
you already have. Progress names each step, and running the same command
again after Ctrl-C attaches to the create already under way. It no longer
reads keys or models from environment variables: pass the key flag, with
`-` to read it from stdin. `--provider-id` is now `--runtime-provider`, and
`--model` replaces the per-framework model flags.

`mf agent send` sends one message and prints the reply, with files, thinking
and a Ctrl-C that stops the turn on the server; `mf agent chat` holds the
conversation at a prompt. `mf agent update --model` sets a coding agent's
model from its next turn.

`mf automations create` builds its schedule from a preset such as daily or
weekly, timed with `--at`, in this machine's timezone. `mf automations run
--wait` follows the run's reply, and `mf automations result` prints the full
reply of the latest run.

`mf skills install` takes a skill's name, and `mf skills library publish`
puts a local skill folder into your library and onto the agents that have
it. `mf mcp` adds, installs, lists and removes an agent's MCP servers and
writes them to its machine; `mf mcp pull` first reads back servers added on
the machine itself.

`mf sandbox list`, `delete` and `update` show, free and update your
sandboxes, and `mf model-providers list` and `test` show which providers can
serve a framework, with which models.
