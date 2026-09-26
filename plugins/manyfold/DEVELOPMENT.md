# Developing the Manyfold Plugin

## Skill Source and Generation

Maintain skill content in [`apps/cli/src/agent-help/`](../../apps/cli/src/agent-help/).
The builder renders the entry guide and authentication/A2A references, and
includes the workbench and route references. Do not edit the generated
`plugins/manyfold/skills/` files directly.

From the pnpm workspace root, with dependencies installed:

```sh
pnpm --filter '@manyfold/cli^...' build
pnpm --filter @manyfold/cli build:plugin
pnpm --filter @manyfold/cli check:skills
```

In a cloud checkout, run pnpm from the superproject root. The paths below
are relative to the OSS repository root (`oss/` in a cloud checkout).

| Command                  | Output or check                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `build:skills`           | `apps/cli/dist-skills/skills/manyfold-cli-usage/`                                           |
| `build:plugin`           | The standalone output plus the same bundle in `plugins/manyfold/skills/manyfold-cli-usage/` |
| `check:skills`           | Compare the complete checked-in plugin bundle with generated source                         |
| `check:skills:published` | Compare the standalone published directory, resolved to one commit, with generated source   |

`MF_SKILLS_VERSION` controls the generated skill's version, defaulting to
`0.0.0-dev`. Keep its top-level `version` field for compatibility with
Manyfold's skill discovery and release readers. Plugin manifest versions
control host installation independently. Keep the Claude Code and Codex
manifests in sync when releasing the plugin.

## Local Installation

Run these commands from the OSS repository root, which contains both
`.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`:

```sh
claude plugin marketplace add .
claude plugin install manyfold@manyfold
```

```sh
codex plugin marketplace add .
codex plugin add manyfold@manyfold
```

Use the marketplace for the source you intend to test. An existing Git-based
marketplace named `manyfold` must be changed through the host's marketplace
manager before testing a local checkout under that name. After updating plugin
content, refresh its version and reinstall/update it through the host; start
a new conversation to load the updated skill.

## Standalone Publication

Managed agents use the same skill through the standalone repository:
`github:protagolabs/manyfold-skills@main:skills/manyfold-cli-usage`.
Preserve this ID and the skill name so default installation, existing records,
disabled defaults, and administrator overrides continue to work.

From a workspace containing the merged source, an authorized maintainer with
GitHub write access can publish a new skill version:

```sh
pnpm --filter @manyfold/cli exec node scripts/publish-skills.mjs '<version>'
pnpm --filter @manyfold/cli check:skills:published
```

The publisher replaces the generated standalone skill bundle and README,
then pushes `main` and the `skills-v<version>` tag to `protagolabs/manyfold-skills`.
It does not publish or update installed plugin copies. A published-bundle
drift failure is expected between merging source and publishing that bundle.

## Local Integration Tests

These tests exercise CLI/API/Web synchronization. They do not launch Claude
Code or Codex to evaluate whether a host discovers or follows the skill.
Verify host installation separately in a new coding-agent conversation.

Prerequisites:

- An isolated local Manyfold stack running the API and Web changes. The scripts
  accept only localhost/127.0.0.1 URLs. Use the ports printed by your dev stack.
- The installed `mf` CLI, repository dependencies, and Playwright Chromium
  (`pnpm exec playwright install chromium` from the workspace root).
- A disposable agent owned by the test login, with a reachable workspace and
  available channel/skill/automation quota. Do not use an agent being edited
  concurrently: the resource test changes its name and MCP configuration.
- For `plugin-resources.live.mjs`, a Claude Code or Codex agent. The script
  uses the framework's JSON or TOML MCP format and checks this prerequisite
  before changing resources. It does not run a model turn.
- For `plugin-automations.live.mjs`, an agent with a working model provider.
  The test submits one real model turn, which may incur provider usage.

From the OSS repository root, set the target and run the desired test:

```sh
export MF_PLUGIN_TEST_API_URL='http://localhost:<api-port>/api'
export MF_PLUGIN_TEST_WEB_URL='http://localhost:<web-port>'
export MF_PLUGIN_TEST_AGENT_ID='<disposable-agent-id>'
node apps/web/test/plugin-resources.live.mjs
node apps/web/test/plugin-automations.live.mjs
```

The scripts default to the dev login `admin@example.com` / `manyfold-local-dev`.
Override `MF_PLUGIN_TEST_EMAIL` and `MF_PLUGIN_TEST_PASSWORD` for another login.
`MF_PLUGIN_TEST_CLI` selects a different CLI executable;
`MF_PLUGIN_TEST_MODEL` selects the automation test's model override.

The resource test checks channel CRUD across tabs, library edits, skill
installation, agent updates, MCP draft preservation, file tree/preview updates,
mobile layout, and stream recovery. The automation test checks creation,
updates, drafts, execution, result navigation, reconnect, and deletion.
Screenshots and results go to `.e2e-runs/plugin-resources/` and
`.e2e-runs/plugin-automations/` respectively.

Both scripts attempt to remove their temporary resources and revoke their
test API tokens. The resource test also restores the original agent name and
MCP configuration. Cleanup is best-effort; inspect the test account after an
interrupted run. Automation conversations and test evidence may remain.

## Live Update Architecture

The authenticated route owns a reconnecting status stream shared by the tab's
workbench layouts. `ResourceEventsModule` exposes the account-scoped PG/SSE
bus to resource services. Writes emit invalidation signals with identifiers,
not resource contents; pages refetch authorized data and preserve open drafts.
The plugin uses this platform behavior but does not implement the transport.
