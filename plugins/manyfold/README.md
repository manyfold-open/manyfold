# Manyfold coding-agent plugin

The same skills-only package supports Claude Code and Codex. It distributes
the generated `manyfold-cli-usage` skill also installed by default on
Manyfold-managed agents. The skill uses existing `mf` commands, selects
authentication from the actual identity, and shows resources when the host
has browser controls. The first live workflow covers automations.

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
[the skill's route reference](skills/manyfold-cli-usage/references/web-routes.md).
Authenticate with
`mf --profile <name> login`; the workbench may need its own browser login.

Example request: "Use Manyfold to update my daily summary automation and
show the changed schedule. Run it once and open the result."

The plugin does not install a daemon or an MCP server. Authentication
material stays in the CLI profile and is never placed in a workbench URL.

## One skill, two distributions

The maintained source lives in `apps/cli/src/agent-help/`. Do not hand-edit
the generated files under this plugin's `skills/` directory.

```sh
pnpm --filter '@manyfold/cli^...' build
pnpm --filter @manyfold/cli build:plugin
pnpm --filter @manyfold/cli check:skills
```

`build:skills` emits `dist-skills/skills/manyfold-cli-usage/` for the existing
standalone publisher. `build:plugin` writes that same complete bundle here.
`MF_SKILLS_VERSION` sets the bundle version; the default is a development
version. Plugin manifest versions control host installation independently.
The skill retains Manyfold's top-level `version` frontmatter field for
compatibility with existing discovery and standalone-release readers.

Managed agents continue to install
`github:protagolabs/manyfold-skills@main:skills/manyfold-cli-usage`.
They do not need a plugin installer. Creation, attach, existing-skill
updates, and administrator overrides retain their current installation
identity and behavior. Publish the updated standalone bundle through the
normal skills release after the source change is merged.

The plugin replaces its former `manyfold-platform` skill with the shared
`manyfold-cli-usage`. Use one distribution per host where possible: managed
runtimes already receive the standalone skill; external hosts can install
the plugin or the standalone skill. Updating this plugin removes its old
entrypoint but does not overwrite separately installed user skills.

`check:skills` compares every generated file in the plugin and runs as part
of CLI type checks. `check:skills:published` compares the complete standalone
directory at a pinned upstream revision. The reference digest in `SKILL.md`
also makes older entrypoint-only drift checks notice source reference changes.

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
