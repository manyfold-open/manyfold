# Manyfold Skills

Official agent skills for **Manyfold** — the platform for creating, deploying,
and hosting AI agents (Claude Code, Codex, OpenClaw, Hermes, and more).

These skills teach managed agents and external coding agents how to operate
Manyfold through the `mf` CLI and show results when a browser is available.
They use the cross-tool
[Agent Skills](https://code.claude.com/docs/en/skills) format (`SKILL.md`) —
read natively by Claude Code, Codex, and Gemini CLI.

## Skills

### [`manyfold-cli-usage`](skills/manyfold-cli-usage/SKILL.md)

Operate the Manyfold platform and delegate subtasks to peer agents via the `mf`
CLI: channels, automations, skills, files, backups, model config, usage,
auth/scopes, and agent-to-agent (A2A) delegation.
The same skill is bundled in the Manyfold Claude Code/Codex plugin.

## Usage

Manyfold installs `manyfold-cli-usage` by default on supported new agents,
including agents added to an existing runtime, and discovers this repository
automatically. The skill name, source path, and installation ID stay stable.
Existing disabled or custom default-install settings remain authoritative.
To install or update it yourself — from the
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
skills/<name>/references/ # auth, A2A, workbench, and route guidance
```

Each `SKILL.md` carries `name`, `description`, and `version` frontmatter.

## Maintenance

This repository is **generated** — do not edit it by hand; its contents are
overwritten on every release. The source is Manyfold's
`apps/cli/src/agent-help/`; `build:skills` emits the complete standalone
bundle, and `build:plugin` copies the same bundle into the plugin.
The full-directory `check:skills:published` check detects changed, missing,
or unexpected references as well as entrypoint drift.
