---
title: Manage skills with the CLI
description: Discover, install, build, share, export, and distribute agent skills with mf.
order: 9
---
Skills are reusable instruction packages for agents. The CLI covers installed
skills, the public/repository catalog, and your personal skill library.

> **Warning:** Inspect a skill's `SKILL.md` and supporting files before
> installing it. A skill can instruct an agent to use tools and external systems
> with your authority.

## Discover and install

```sh
mf skills discover --q review
mf skills install --skill-id skl_xxx --agent-id agt_xxx
mf skills installed --agent-id agt_xxx
```

Discovery is paginated: results arrive one page at a time (up to 100 per
page, featured ranking by default; `--sort latest` ranks by recency). When
more results exist the command prints a hint with the cursor to pass as
`--cursor`, and `--json` output is the page object — `items` plus a
`nextCursor` that is `null` on the last page.

Install to several agents with:

```sh
mf skills install --skill-id skl_xxx --agent-ids agt_one,agt_two
```

Installation state is separate from enablement:

- `installing` — materialization is still running
- `installed` — the skill is present and its `SKILL.md` is loadable
- `failed` — materialization failed; inspect the sanitized reason and retry

Do not treat `installing` as ready.

## Enable, disable, or uninstall

```sh
mf skills update usk_xxx --enabled
mf skills update usk_xxx --disabled
mf skills delete usk_xxx --yes
```

The ID here is the installed user-skill ID returned by `skills installed`, not
the catalog skill ID. Uninstall is irreversible and requires explicit
`--yes`.

## Personal library

```sh
mf skills library list
mf skills library get skl_xxx
mf skills library create --name my-review --content-file ./SKILL.md
mf skills library update skl_xxx --content-file ./SKILL.md
```

Import from GitHub, a catalog entry, an unlisted share link, or a `.skill`/zip
archive:

```sh
mf skills library import --url https://github.com/example/skills/tree/main/review
mf skills library import --file ./review.skill
mf skills library import --share https://manyfold.ai/skills/shared/lss_xxx
```

Supporting files are managed separately:

```sh
mf skills library files set skl_xxx \
  --path references/guide.md \
  --content-file ./guide.md
mf skills library files delete skl_xxx skf_xxx
```

## Share, export, and push

```sh
mf skills library share skl_xxx
mf skills library export skl_xxx -o ./review.skill
mf skills library push skl_xxx
```

Share links are unlisted, not private authentication boundaries. Revoke a link
when it should no longer import snapshots. `push` updates agents that already
have the library skill installed; inspect per-agent results because one stopped
agent does not block the rest.

`mf skills repos` manages skill repositories and requires admin or `api.full`
access; normal users rarely need it.

## See also

- [Use the workspace](/docs/workspace/)
- [Scripting with mf](/docs/scripting/)
- [CLI command reference](/docs/cli/reference/)
