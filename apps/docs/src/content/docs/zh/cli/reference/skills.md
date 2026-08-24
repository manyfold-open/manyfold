---
title: "mf skills"
description: "Manage installed agent skills"
order: 13
---
**用法:** `mf skills [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
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

**用法:** `mf skills installed [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-id <id>` | filter to this agent |
| `--include-runtime` | include runtime-level skills |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf skills discover`

Discover skills available to install

**用法:** `mf skills discover [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-id <id>` | filter to this agent context |
| `--q <query>` | search query |
| `--repo-id <id>` | filter to a specific repo |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf skills install`

Install a skill on one agent (or many via --agent-ids)

**用法:** `mf skills install [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--skill-id <id>` | skill id from discover or library 必填。 |
| `--agent-id <id>` | agent id (defaults to the global --agent-id / $MF_AGENT_ID) |
| `--agent-ids <ids>` | comma-separated agent ids for a batch install |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf skills update`

Enable or disable an installed skill

**用法:** `mf skills update [options] <userSkillId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<userSkillId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--enabled` | enable the skill |
| `--disabled` | disable the skill |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf skills delete`

Uninstall a skill

**用法:** `mf skills delete [options] <userSkillId>`

**Alias:** `rm`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<userSkillId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `-y, --yes` | confirm uninstall |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf skills library`

Manage your personal skill library

**用法:** `mf skills library [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
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

**用法:** `mf skills library list [options]`

**Alias:** `ls`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills library get`

Show a library skill (metadata + SKILL.md)

**用法:** `mf skills library get [options] <skillId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<skillId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills library create`

Create a library skill

**用法:** `mf skills library create [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--name <name>` | skill name 必填。 |
| `--description <text>` | skill description |
| `--content <markdown>` | SKILL.md content inline |
| `--content-file <path>` | read SKILL.md content from a file |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills library update`

Update a library skill (name / description / SKILL.md)

**用法:** `mf skills library update [options] <skillId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<skillId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--name <name>` | new skill name |
| `--description <text>` | new description |
| `--content <markdown>` | new SKILL.md content inline |
| `--content-file <path>` | read new SKILL.md from a file |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills library import`

Import a skill from a GitHub URL, catalog entry, share link, or .skill/.zip archive

**用法:** `mf skills library import [options]`

**Option**

| Option | 用途 |
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

**用法:** `mf skills library share [options] <skill>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<skill>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--revoke` | revoke the active share link |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills library export`

Download a library skill as a .skill archive

**用法:** `mf skills library export [options] <skillId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<skillId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `-o, --output <path>` | output file path |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills library delete`

Delete a library skill

**用法:** `mf skills library delete [options] <skillId>`

**Alias:** `rm`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<skillId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `-y, --yes` | confirm deletion |
| `--force` | uninstall from all agents before deleting |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

### `mf skills library push`

Push the current skill content to installed agents (all by default)

**用法:** `mf skills library push [options] <skillId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<skillId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-ids <ids>` | comma-separated agent ids to push to |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills library files`

Manage a library skill’s supporting files

**用法:** `mf skills library files [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf skills library files set`](#mf-skills-library-files-set) | Create or update a supporting file |
| [`mf skills library files delete`](#mf-skills-library-files-delete) | Delete a supporting file |

#### `mf skills library files set`

Create or update a supporting file

**用法:** `mf skills library files set [options] <skillId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<skillId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--path <path>` | file path inside the skill 必填。 |
| `--content <text>` | file content inline |
| `--content-file <path>` | read file content from a local file |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

#### `mf skills library files delete`

Delete a supporting file

**用法:** `mf skills library files delete [options] <skillId> <fileId>`

**Alias:** `rm`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<skillId>` |  |
| `<fileId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf skills repos`

Manage skill repositories (admin / api.full)

**用法:** `mf skills repos [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf skills repos list`](#mf-skills-repos-list) | List skill repos |
| [`mf skills repos create`](#mf-skills-repos-create) | Register a new skill repo |
| [`mf skills repos update`](#mf-skills-repos-update) | Update a skill repo (branch / enabled) |
| [`mf skills repos delete`](#mf-skills-repos-delete) | Remove a skill repo |

### `mf skills repos list`

List skill repos

**用法:** `mf skills repos list [options]`

**Alias:** `ls`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills repos create`

Register a new skill repo

**用法:** `mf skills repos create [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--owner <owner>` | github owner 必填。 |
| `--name <name>` | repo name 必填。 |
| `--branch <branch>` | branch (default: main) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills repos update`

Update a skill repo (branch / enabled)

**用法:** `mf skills repos update [options] <repoId>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<repoId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--branch <branch>` | new branch |
| `--enabled` | enable the repo |
| `--disabled` | disable the repo |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf skills repos delete`

Remove a skill repo

**用法:** `mf skills repos delete [options] <repoId>`

**Alias:** `rm`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<repoId>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `-y, --yes` | confirm deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
