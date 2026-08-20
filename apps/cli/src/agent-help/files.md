# mf files — agent guide

## Purpose

Read and write files on an agent runtime through the platform API. The agent
comes from `--agent-id` or `$MF_AGENT_ID`, so acting on your own runtime needs
no agent argument; passing an extra leading argument still targets that agent
id explicitly. Paths are relative to a file root (default: workspace); pick
another root with `--root <rootId>` after checking `mf files roots`.

## Required scopes

> Required **only for `--account`** (account-wide) actions. Operating your
> **own** agent (the default) needs no permission.

- `files:read` — needed for `roots`, `list`, `stat`, `read`, `download`
- `files:edit` — needed for `write`, `upload`, `mkdir`, `mv`, `rm`

Missing a scope? `mf auth ensure --scopes <missing>` — see `mf help auth --agent`.

## Common commands

```sh
mf files roots
mf files list <path> --json               # alias: ls; no path lists the root
mf files stat <path> --root <rootId>
mf files download <remotePath> [localPath]   # localPath `-` writes to stdout
mf files upload <localPath> [remotePath]
mf files read <path> --output <localPath>    # same transfer as download
mf files write <path> --content <data>       # or --file <localPath>
mf files mkdir <path>
mf files mv <from> <to>
mf files rm <path> --recursive --yes
```

`upload` and `download` stream, so file size does not drive memory use.
Downloads land in `<localPath>.mf-part` and are renamed on success: an
interrupted transfer leaves the existing file alone.

`mf files roots` reports each root's real transfer limits, e.g.
`[up<=5MiB down<=50MiB]`, and marks a root whose runtime cannot store raw bytes
as `text-only`. Check it before pushing a large or binary file — an upload over
the limit is refused with `413`.

## Output

- `roots` and `list` print human-readable lines; add `--json` for raw
  JSON. `stat` always prints JSON.
- `read` streams raw file bytes to stdout; with `--output <localPath>`
  it saves locally and prints a byte-count confirmation instead.
- `upload` and `download` print a one-line `✓` with the transferred size;
  add `--json` for `{ ok, path, bytes }`. Progress goes to stderr on a TTY
  only, so piping stdout stays clean.
- `write`, `mkdir`, `mv`, `rm` print a one-line `✓ <action>` on success;
  add `--json` for `{ ok, path }` (`mv` returns `{ ok, from, to }`).

## Failure recovery

- "not authenticated" → `mf help auth --agent`
- "agent id is required" → pass `--agent-id`, set `$MF_AGENT_ID`, or lead with
  the agent id positionally
- `401` → missing scope; request just that scope (existing ones are
  kept): `mf auth ensure --scopes <missing scope>`, then retry
- `403` (agent mismatch) → the action targets a different agent than your
  identity; act on `$MF_AGENT_ID`
- `403` `root "<id>" is read-only` → pick a writable root; `mf files
roots` marks read-only roots with `(ro)`
- `403` "cannot move the mount root" → `mv` the contents, not the root
- `413` "exceeds the … limit" → the root cannot take a file that size; check
  `mf files roots` for the cap
- "binary writes are not supported … until the daemon CLI is upgraded" → the
  agent's host runs an older `mf`; upgrade it or send text
- "refusing to remove <path> without --yes" → local guard on `rm`; add
  `-y`/`--yes` only after confirming the target
- 404 "no such file" → wrong path or root; `mf files list` the parent
- "--content or --file is required" → `write` needs exactly one source
- "--content and --file are mutually exclusive" → pass only one
- "no such local file" → `upload` could not open the local path
- "truncated download" → the transfer ended early; the destination was left
  untouched, retry
