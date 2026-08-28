---
title: What are Manyfold Automations?
description: Run an Agent on a schedule or workflow condition, then deliver its report, file, or status to a workspace, Channel, or team entry point.
order: 8
---
**An Automation is a scheduled Agent run.** Define the Agent, workspace, prompt, trigger, and output; the Agent can then run without opening a chat window every time.

Automations work best for repeatable, verifiable tasks with clear stop conditions. Keep cost, permission, and human review boundaries in production.

## Good use cases

- **Recurring summaries**: Summarize project progress, issues, pull requests, or usage every day or week.
- **Code and status checks**: Run tests, inspect logs, scan pending work, and return a result.
- **Team updates**: Deliver completion or exception updates to Slack, Telegram, Discord, and other Channels.

## How do Automations, Agents, and Channels fit together?

| Stage | Component | What it does |
| ----- | --------- | ------------ |
| **Trigger** | Automation | Decides when work starts, such as a schedule or manual run. |
| **Execution** | Agent + workspace | Reads allowed files and tools, executes the prompt, and produces a reviewable result. |
| **Delivery** | Channel or workspace | Sends the report, file, or status to the team's existing entry point. |

In short: Automation decides "when," the Agent decides "what," and the Channel decides "where the result goes."

**Ready to create an Automation?** Read the [Automation UI creation and management guide](/docs/automations/create/). To deliver results to a team tool, start with [Connect Slack to Manyfold](/docs/channels/slack/).

## See also

- [Create and manage an Automation in the UI](/docs/automations/create/)
- [Learn the mf CLI](/docs/cli/)
- [Send results to Slack](/docs/channels/slack/)
- [Send results to Telegram](/docs/channels/telegram/)
- [Read the Automation CLI reference](/docs/cli/automations/)
- [Manyfold FAQ](/docs/faq/)
