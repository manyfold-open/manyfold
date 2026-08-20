# Manyfold Skills

Official agent skills for **Manyfold** — the platform for creating, deploying,
and hosting AI agents (Claude Code, Codex, OpenClaw, Hermes, and more).

These skills teach a hosted agent how to operate the Manyfold platform on its
user's behalf through the `mf` CLI. They use the cross-tool
[Agent Skills](https://code.claude.com/docs/en/skills) format (`SKILL.md`) —
read natively by Claude Code, Codex, and Gemini CLI.

## Skills

### [`manyfold-cli-usage`](skills/manyfold-cli-usage/SKILL.md)

Operate the Manyfold platform and delegate subtasks to peer agents via the `mf`
CLI: channels, automations, skills, files, backups, model config, usage,
auth/scopes, and agent-to-agent (A2A) delegation.

## Usage

Manyfold installs `manyfold-cli-usage` by default on new agents and discovers
this repository automatically. To install or update it yourself — from the
Manyfold web app's **Skills** page, or with the CLI:

```sh
mf skills discover --agent-id <agent>
mf skills install \
  --skill-id github:protagolabs/manyfold-skills@main:skills/manyfold-cli-usage \
  --agent-id <agent>
```

When a new version is published, the **Skills** page flags an update and one
click re-materializes the latest.

## Layout

```
skills/<name>/SKILL.md   # one directory per skill
```

Each `SKILL.md` carries `name`, `description`, and `version` frontmatter.

## Maintenance

This repository is **generated** — do not edit it by hand; its contents are
overwritten on every release. The skills are single-sourced with Manyfold's
`mf help --agent` guide, so they never drift from the CLI.
