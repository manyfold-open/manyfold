# Manyfold coding-agent plugin

The same skills-only package supports Claude Code and Codex. It calls an
installed `mf` CLI and opens the existing Manyfold workbench. The first live
workflow covers automation creation, updates, deletion, runs, and results.

Install from a checkout containing this change:

```sh
claude plugin marketplace add /absolute/path/to/manyfold
claude plugin install manyfold@manyfold

codex plugin marketplace add /absolute/path/to/manyfold
codex plugin add manyfold@manyfold
```

For Codex Desktop use its bundled CLI. Start a new coding-agent conversation
after installation. The plugin uses existing `mf` resource commands;
the API and Web must include automation resource events for live updates.
Workbench routes and deployment URL rules are maintained in
[the skill's route reference](skills/manyfold-platform/references/web-routes.md).
Authenticate with
`mf --profile <name> login`; the workbench may need its own browser login.

Example request: "Use Manyfold to update my daily summary automation and
show the changed schedule. Run it once and open the result."

The plugin does not install a daemon or an MCP server. Authentication
material stays in the CLI profile and is never placed in a workbench URL.

## Local verification

The live Playwright check uses the installed `mf` CLI. It requires explicit
local dev API and Web URLs plus an existing runnable agent. It creates
temporary automations and an API token, performs one real model turn, and
removes its automations and token afterward:

```sh
MF_PLUGIN_TEST_API_URL=http://localhost:7120/api \
MF_PLUGIN_TEST_WEB_URL=http://localhost:7121 \
MF_PLUGIN_TEST_AGENT_ID=<agent-id> \
node apps/web/test/plugin-automations.live.mjs
```

It defaults to the dev-stack admin login; override `MF_PLUGIN_TEST_EMAIL`
and `MF_PLUGIN_TEST_PASSWORD` when needed. `MF_PLUGIN_TEST_CLI` optionally
selects another CLI executable; `MF_PLUGIN_TEST_MODEL` selects an automation
model override. Screenshots and results go into
`.e2e-runs/plugin-automations/`. Checks cover two live tabs, unsaved input,
run completion, result navigation, mobile layout, reconnect, and deletion.
