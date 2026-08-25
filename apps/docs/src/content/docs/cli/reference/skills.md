---
title: "mf skills"
description: "Manage installed agent skills"
order: 13
---
**Usage:** `mf skills [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf skills installed`](#mf-skills-installed) | List installed skills (optionally filter by agent) |
| [`mf skills discover`](#mf-skills-discover) | Discover skills available to install |
| [`mf skills install`](#mf-skills-install) | Install a skill on one agent (or many via --agent-ids) |
| [`mf skills update`](#mf-skills-update) | Enable or disable an installed skill |
| [`mf skills delete`](#mf-skills-delete) | Uninstall a skill |
| [`mf skills library`](#mf-skills-library) | Manage your personal skill library |
| [`mf skills repos`](#mf-skills-repos) | Manage skill repositories (admin / api.full) |

## `mf skills installed`

List installed skills (optionally filter by agent)

**Usage:** `mf skills installed [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-id <id>` | filter to this agent |
| `--include-runtime` | include runtime-level skills |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf skills discover`

Discover skills available to install

**Usage:** `mf skills discover [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-id <id>` | filter to this agent context |
| `--q <query>` | search query |
| `--repo-id <id>` | filter to a specific repo |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf skills install`

Install a skill on one agent (or many via --agent-ids)

**Usage:** `mf skills install [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--skill-id <id>` | skill id from discover or library Required. |
| `--agent-id <id>` | agent id (defaults to the global --agent-id / $MF_AGENT_ID) |
| `--agent-ids <ids>` | comma-separated agent ids for a batch install |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf skills update`

Enable or disable an installed skill

**Usage:** `mf skills update [options] <userSkillId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<userSkillId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--enabled` | enable the skill |
| `--disabled` | disable the skill |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf skills delete`

Uninstall a skill

**Usage:** `mf skills delete [options] <userSkillId>`

**Aliases:** `rm`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<userSkillId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `-y, --yes` | confirm uninstall |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf skills library`

Manage your personal skill library

**Usage:** `mf skills library [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf skills library list`](#mf-skills-library-list) | List library skills |
| [`mf skills library get`](#mf-skills-library-get) | Show a library skill (metadata + SKILL.md) |
| [`mf skills library create`](#mf-skills-library-create) | Create a library skill |
| [`mf skills library update`](#mf-skills-library-update) | Update a library skill (name / description / SKILL.md) |
| [`mf skills library import`](#mf-skills-library-import) | Import a skill from a GitHub URL, catalog entry, share link, or .skill/.zip archive |
| [`mf skills library share`](#mf-skills-library-share) | Create or show the share link for a library skill (id or name) |
| [`mf skills library export`](#mf-skills-library-export) | Download a library skill as a .skill archive |
| [`mf skills library delete`](#mf-skills-library-delete) | Delete a library skill |
| [`mf skills library push`](#mf-skills-library-push) | Push the current skill content to installed agents (all by default) |
| [`mf skills library files`](#mf-skills-library-files) | Manage a library skill’s supporting files |

### `mf skills library list`

List library skills

**Usage:** `mf skills library list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills library get`

Show a library skill (metadata + SKILL.md)

**Usage:** `mf skills library get [options] <skillId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<skillId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills library create`

Create a library skill

**Usage:** `mf skills library create [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--name <name>` | skill name Required. |
| `--description <text>` | skill description |
| `--content <markdown>` | SKILL.md content inline |
| `--content-file <path>` | read SKILL.md content from a file |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills library update`

Update a library skill (name / description / SKILL.md)

**Usage:** `mf skills library update [options] <skillId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<skillId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--name <name>` | new skill name |
| `--description <text>` | new description |
| `--content <markdown>` | new SKILL.md content inline |
| `--content-file <path>` | read new SKILL.md from a file |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills library import`

Import a skill from a GitHub URL, catalog entry, share link, or .skill/.zip archive

**Usage:** `mf skills library import [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--url <url>` | github.com repo / tree / SKILL.md blob URL |
| `--file <path>` | local .skill or .zip archive |
| `--catalog-skill-id <id>` | copy a catalog skill to the library |
| `--share <url-or-id>` | copy a shared skill via its link or lss_… id |
| `--on-conflict <mode>` | fail \| overwrite \| rename |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills library share`

Create or show the share link for a library skill (id or name)

**Usage:** `mf skills library share [options] <skill>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<skill>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--revoke` | revoke the active share link |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills library export`

Download a library skill as a .skill archive

**Usage:** `mf skills library export [options] <skillId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<skillId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `-o, --output <path>` | output file path |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills library delete`

Delete a library skill

**Usage:** `mf skills library delete [options] <skillId>`

**Aliases:** `rm`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<skillId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `-y, --yes` | confirm deletion |
| `--force` | uninstall from all agents before deleting |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

### `mf skills library push`

Push the current skill content to installed agents (all by default)

**Usage:** `mf skills library push [options] <skillId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<skillId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-ids <ids>` | comma-separated agent ids to push to |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills library files`

Manage a library skill’s supporting files

**Usage:** `mf skills library files [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf skills library files set`](#mf-skills-library-files-set) | Create or update a supporting file |
| [`mf skills library files delete`](#mf-skills-library-files-delete) | Delete a supporting file |

#### `mf skills library files set`

Create or update a supporting file

**Usage:** `mf skills library files set [options] <skillId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<skillId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--path <path>` | file path inside the skill Required. |
| `--content <text>` | file content inline |
| `--content-file <path>` | read file content from a local file |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

#### `mf skills library files delete`

Delete a supporting file

**Usage:** `mf skills library files delete [options] <skillId> <fileId>`

**Aliases:** `rm`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<skillId>` |  |
| `<fileId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf skills repos`

Manage skill repositories (admin / api.full)

**Usage:** `mf skills repos [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf skills repos list`](#mf-skills-repos-list) | List skill repos |
| [`mf skills repos create`](#mf-skills-repos-create) | Register a new skill repo |
| [`mf skills repos update`](#mf-skills-repos-update) | Update a skill repo (branch / enabled) |
| [`mf skills repos delete`](#mf-skills-repos-delete) | Remove a skill repo |

### `mf skills repos list`

List skill repos

**Usage:** `mf skills repos list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills repos create`

Register a new skill repo

**Usage:** `mf skills repos create [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--owner <owner>` | github owner Required. |
| `--name <name>` | repo name Required. |
| `--branch <branch>` | branch (default: main) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills repos update`

Update a skill repo (branch / enabled)

**Usage:** `mf skills repos update [options] <repoId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<repoId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--branch <branch>` | new branch |
| `--enabled` | enable the repo |
| `--disabled` | disable the repo |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills repos delete`

Remove a skill repo

**Usage:** `mf skills repos delete [options] <repoId>`

**Aliases:** `rm`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<repoId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `-y, --yes` | confirm deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
