# mf skills — agent guide

## Purpose

Manage agent skills: list what is installed, discover installable skills
from registered skill repos, install them on an agent, enable/disable
them, and uninstall them. The `mf skills repos` subtree manages the
GitHub repos skills are discovered from. The `mf skills library` subtree
manages the user's personal skill library — skills whose SKILL.md and
supporting files live on the platform (created in the app, imported from
GitHub, or uploaded as a `.skill` archive) instead of a GitHub repo.

## Required scopes

> Required **only for `--account`** (account-wide) actions. Operating your
> **own** agent (the default) needs no permission.

- `skills:read` — `installed`, `discover` (list installed skills, browse
  the skill catalog).
- `skills:edit` — `install`, `update`, `delete` (install, enable/disable,
  uninstall a skill).
- `mf skills repos …` is admin-level (`api.full` token, not grantable);
  ask the user to manage repos themselves if a repo change is needed.
- `mf skills library …` reads (`list`, `get`, `export`) work with
  `skills:read`, including for agent-bound tokens. Library mutations
  (`create`, `update`, `import`, `delete`, `files …`, `share`) are
  user-only — agent-bound tokens are refused even with `skills:edit`;
  hand those back to the user.

Missing a scope? `mf auth ensure --scopes <missing>` — see `mf help auth --agent`.

## Common commands

```sh
mf skills installed --agent-id "$MF_AGENT_ID" --json
mf skills installed --include-runtime
mf skills discover --q <query> --json
mf skills discover --repo-id <repo-id> --agent-id "$MF_AGENT_ID"
mf skills install --skill-id <skill-id> --agent-id "$MF_AGENT_ID"
mf skills update <user-skill-id> --enabled
mf skills delete <user-skill-id> --yes
mf skills repos list --json
mf skills library list --json
mf skills library get <skl-id> --json
mf skills library create --name <name> --content-file ./SKILL.md
mf skills library update <skl-id> --content-file ./SKILL.md
mf skills library import --url <github-url> --on-conflict rename
mf skills library import --file ./my-skill.skill
mf skills library import --share https://manyfold.ai/skills/shared/<lss-id>
mf skills library share <skl-id-or-name> --json
mf skills library share <skl-id-or-name> --revoke
mf skills library export <skl-id> -o ./my-skill.skill
mf skills library files set <skl-id> --path references/guide.md --content-file ./guide.md
mf skills library files delete <skl-id> <skf-file-id>
mf skills library push <skl-id>
mf skills library delete <skl-id> --yes --force
mf skills install --skill-id <skill-id> --agent-ids <id1>,<id2>
```

`install` returns a user-skill id — use that for `update` / `delete`, not
the catalog `<skill-id>` from `discover`. `delete` has alias `rm`.

`discover --json` prints a page object `{items, nextCursor}` (max 100 per
page, `--sort featured|latest`); pass `nextCursor` back as `--cursor` until
it is `null`.

Library skills install with the same `mf skills install`, passing the
`skl_…` library id as `--skill-id`. `install` takes exactly one of
`--agent-id` or `--agent-ids` (comma-separated batch; per-agent results,
one failure does not abort the rest). `library import` accepts exactly one
of `--url` (github.com repo / tree / SKILL.md blob), `--file` (`.skill` /
`.zip`), `--catalog-skill-id`, or `--share` (a share link or `lss_…` id);
`--on-conflict` is `fail` (default) | `overwrite` | `rename`.
`library share` mints (or prints, if one exists) an unlisted link anyone
can open to view the skill and import a snapshot copy into their own
library; `--revoke` disables the link (already-imported copies keep
working). `library push` re-delivers the current content to
every agent that has the skill installed (or `--agent-ids` to narrow) —
run it after editing. `library delete` refuses while installed on agents
unless `--force` (which uninstalls everywhere first).

## Output

- `installed`: one header per agent (`<name> (<id>)`), then one line per
  skill: `<user-skill-id>  <install-dir>  enabled|disabled`. Prints
  `(no installed skills)` when empty.
- `discover`: `<skill-id>  <name>  <description>` per line.
- `install` / `update`: `<user-skill-id>  <name>  enabled|disabled`.
- `delete`: `✓ deleted <id>` on success.
- `--json` (raw JSON) exists on every subcommand; `delete` and
  `repos delete` emit `{ ok, id }`. Skills output contains no secrets.

## Failure recovery

- "not authenticated" → `mf help auth --agent`.
- `401` → missing `skills:read` / `skills:edit`; request just that scope
  (existing ones are kept):
  `mf auth ensure --scopes <missing scope>`, then retry.
- `403` → the action targets a different agent than your identity; act on
  `$MF_AGENT_ID`.
- `pass exactly one of --enabled or --disabled` → `update` requires
  exactly one of the two flags.
- `refusing to delete … without --yes` → deletes never prompt; add `--yes`
  (or `-y`) to confirm.
- `401` on `mf skills repos …` despite a fresh grant → repos endpoints
  need `api.full`; hand the task back to the user.
