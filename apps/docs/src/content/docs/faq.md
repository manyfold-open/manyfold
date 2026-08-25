---
title: FAQ
description: Common questions about agents, runtimes, providers, channels, and safety.
order: 30
---
## Is Manyfold just a chat wrapper?

No. Manyfold hosts real agent runtimes with [workspace files, terminal access, resumable sessions](/docs/workspace/), provider settings, skills, and optional [channel connections](/docs/channels/).

## Which agent should I choose first?

For repository work, start with Claude Code or Codex. Choose Gemini CLI if your workflow already depends on Gemini. Use Hermes Agent or OpenClaw when you need a framework-style agent for connectors, services, scheduled jobs, or product workflows.

## Can I attach files when I chat with an agent?

Yes. Use the attachment button in the chat composer to add images or documents to a message, and the agent receives them along with your text. Most agents support attachments, including Claude Code, Codex, Gemini CLI, OpenClaw, Hermes, and Dify. For a Dify agent, make sure file upload is enabled for the connected Dify app and that the app allows the file types you send.

## Do I need my own model keys?

You can bring your own [provider keys](/docs/model-providers/). Some workspaces may also have managed model access. The creation flow shows the options available to your account.

## What is the difference between a stateful sandbox and a cloud computer?

A stateful sandbox is best for interactive coding and task work. It can pause and resume while keeping the workspace state.

A cloud computer is best for always-on work such as services, connectors, or scheduled workflows. Rent it first from **Settings -> Plan & billing -> Buy container**, then attach agents to it.

## Can I run agents on my own machine?

Yes. Use **Settings -> Self-owned computers** to issue a token, then [register the machine](/docs/local-daemons/) with the `mf` CLI. The registered machine appears as a self-owned computer and is useful when the agent needs access to local files, hardware, or a private network that is not available from the cloud workspace.

## Can I connect one agent to multiple channels?

Yes. Create one channel per external bot or app. Keep labels clear so you know which team, room, or workflow each channel serves.

## Where should I put secrets?

Put model keys in **Settings -> Model providers** and channel tokens in **Settings -> Channels**. Do not paste secrets into chat prompts, files, issue descriptions, or public logs.

## Can agents make mistakes?

Yes. AI-generated work can be wrong or incomplete. Review important outputs, inspect code changes, and run tests before relying on an agent's work.

## How do I reduce unexpected costs?

Use clear prompts, stop runs that are going in the wrong direction, review **Settings -> Usage**, and confirm the agent is using the intended provider and model.

## How do I get support?

Contact support from your Manyfold workspace or email [hi@manyfold.ai](mailto:hi@manyfold.ai). Include the agent name, approximate time, and a short description of what happened. Do not include secrets.
