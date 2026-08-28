---
title: What are Manyfold Automations?
description: Run an agent on a schedule or workflow condition, then deliver its report, file, or status to a workspace, channel, or team entry point.
order: 8
---
**An automation is a scheduled agent run.** Define the agent, workspace, prompt, trigger, and output; the agent can then run without opening a chat window every time.

Automations work best for repeatable, verifiable tasks with clear stop conditions. Keep cost, permission, and human review boundaries in production.

## Good use cases

- **Recurring summaries**: Summarize project progress, issues, pull requests, or usage every day or week.
- **Code and status checks**: Run tests, inspect logs, scan pending work, and return a result.
- **Team updates**: Deliver completion or exception updates to Slack, Telegram, Discord, and other channels.

## How do automations, agents, and channels fit together?

| Stage | Component | What it does |
| ----- | --------- | ------------ |
| **Trigger** | automation | Decides when work starts, such as a schedule or manual run. |
| **Execution** | agent + workspace | Reads allowed files and tools, executes the prompt, and produces a reviewable result. |
| **Delivery** | channel or workspace | Sends the report, file, or status to the team's existing entry point. |

In short: automation decides "when," the agent decides "what," and the channel decides "where the result goes."

**Ready to create an automation?** Read [Create and manage automations](/docs/automations/create/). To deliver results to a team tool, start with [Connect Slack to Manyfold](/docs/channels/slack/).

## See also

- [Create and manage an automation in the UI](/docs/automations/create/)
- [Learn the mf CLI](/docs/cli/)
- [Send results to Slack](/docs/channels/slack/)
- [Send results to Telegram](/docs/channels/telegram/)
- [Manage automations with the CLI](/docs/cli/automations/)
- [Manyfold FAQ](/docs/faq/)
