---
title: Use the workspace
description: Work with chat, files, terminal sessions, usage, skills, and resumable agent sessions.
order: 5
---
The workspace is where you talk to an agent and inspect the work it is doing. Each agent has its own chat sessions, files, terminal access, skills, and settings.

## Chat

Use chat for tasks, review, and follow-up instructions. Good prompts include:

- The goal.
- The files, repository area, or system the agent should inspect.
- Constraints, such as "do not commit" or "explain before editing".
- The expected output, such as a patch, summary, checklist, or test result.

For long tasks, ask for progress updates and verification steps.

## Files

Use the file browser to inspect the agent workspace. Coding agents can read and change files in their workspace during a session.

Keep source-of-truth files in your repository or connected storage. Treat generated files as work in progress until you have reviewed them.

## Terminal

The terminal gives direct access to the agent workspace. Use it to run checks, inspect command output, or debug setup issues.

Commands run in the selected agent's workspace. Use caution with commands that delete files, rotate credentials, or change external services.

## Sessions

Sessions are resumable. You can leave a task, return later, and continue from the same conversation and workspace state.

Use separate sessions when the work has a different goal or should not share context with the previous thread.

## Skills

Skills are reusable instructions and workflows that can be installed for supported agents. Use them when you want the agent to follow a repeatable process, such as review, release notes, or domain-specific troubleshooting.

Open **Skills** from the workspace or settings area, install the skill, then ask the agent to use it in chat.

## Usage

Open **Settings -> Usage** to review model usage and costs by time range, agent, and provider. If a task is expensive or unexpected, stop the run and check the provider and model settings before retrying.

## Good operating habits

- Start with a small task and expand once the agent is oriented.
- Review code and files before shipping.
- Keep credentials in provider settings or channel settings, not in prompts.
- Use [channel connections](/docs/channels/) only after the agent works well in the web workspace.
- Delete unused agents or runtimes when you no longer need them.

## See also

- [Create your first agent](/docs/create-agent/)
- [Connect channels](/docs/channels/)
- [Manage skills with the CLI](/docs/cli/skills/)
- [Query usage with the CLI](/docs/cli/usage/)
