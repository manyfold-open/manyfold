# Manyfold Plugin

Use Claude Code or Codex to manage your Manyfold agents, channels,
automations, skills, connections, files, and backups through the `mf` CLI.
The plugin provides the `manyfold-cli-usage` skill: instructions for choosing
commands, using the correct identity, verifying results, and linking to the
Manyfold workbench.

## Requirements

- Claude Code or Codex with plugin support and shell access.
- The [Manyfold CLI](https://docs.manyfold.ai/docs/install/) installed in the
  environment where the coding agent executes commands. Check with `mf version`.
- Access to a Manyfold account or self-hosted deployment.

The plugin contains instructions, not the CLI or a browser integration.
Managing resources does not require `mf setup`, which registers an execution
host. Supported agents created inside Manyfold already receive this skill
by default unless their administrator changes that setting; they do not need
the plugin installed separately.

## Install

### Claude Code

```sh
claude plugin marketplace add manyfold-open/manyfold
claude plugin install manyfold@manyfold
```

### Codex

Use a Codex CLI that supports `codex plugin`; for a Desktop installation,
use the CLI bundled with that app.

```sh
codex plugin marketplace add manyfold-open/manyfold
codex plugin add manyfold@manyfold
```

Start a new coding-agent conversation after installation. For a local source
checkout, see [development installation](DEVELOPMENT.md#local-installation).

## Authenticate

### External Coding Agents

For the hosted service, sign in and verify your identity:

```sh
mf --profile manyfold login --api-url https://api.manyfold.ai/api
mf --profile manyfold whoami --json
```

Use your deployment's API base URL for self-hosted Manyfold. Tell the coding
agent which CLI profile to use and, when showing results, the corresponding
Web URL. Browser login is separate from CLI login.

### Agents Running Inside Manyfold

Use the platform-injected identity and API endpoint. Do not replace them
with a personal login. The skill guides the agent through permission requests
when an operation needs additional grants.

## Use

Ask the coding agent for the operation you need. For example:

- "Use the manyfold profile to list my agents and their channels."
- "Pause my daily summary automation and show its updated schedule."
- "Install this skill on my research agent and verify the installation."
- "Read the report in my agent's workspace and show it in Manyfold."

The agent uses `mf` with your existing permissions and reads back results.
Commands and options are documented by `mf help --agent`.

## View Results

When the coding-agent host provides browser controls, the skill guides the
agent to open the relevant workbench page. Otherwise it can return a resource
link. [Route and deployment rules](skills/manyfold-cli-usage/references/web-routes.md)
keep the browser and CLI on the same deployment.

Live refresh is a Manyfold API/Web feature. Deployments with resource events
refresh supported open views when resources change, regardless of which
client made the change. Installing this plugin alone does not enable live
refresh on an older deployment or add browser controls to the host.

Supported views include automations, channels, installed skills, the skill
library list, connections, agent settings, files, and backups. Open drafts
are preserved. File events cover API/CLI writes; direct filesystem changes
inside a runtime are not watched. See [workbench guidance](skills/manyfold-cli-usage/references/workbench.md)
for coverage and result verification.

For generation, publishing, and testing, see [Development](DEVELOPMENT.md).
