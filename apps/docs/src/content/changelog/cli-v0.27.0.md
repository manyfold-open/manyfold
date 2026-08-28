---
version: "0.27.0"
date: "2026-08-28"
---

Skill discovery now pages like the rest of the catalog, and a long-obsolete
timeout variable finishes its migration.

- **`mf skills discover` is paginated.** New `--sort featured|latest`,
  `--cursor` and `--limit` (up to 100 per page, which is also the default —
  today's catalogs still fit in one response). When more results exist, the
  command prints the next cursor as a hint on stderr; pass it back with
  `--cursor` to continue.

- **`--json` output changes shape.** It used to print a bare array of skill
  summaries; it now prints the page object — `{"items": [...], "nextCursor":
  "100" | null}`. Scripts that parse the JSON should read `.items` and follow
  `nextCursor` until it is `null`. Human-readable output now follows the
  catalog's featured ranking.

- **`A2A_TURN_TIMEOUT_MS` retires.** If your deployment still sets this legacy
  env var, the API migrates its value into the *A2A turn timeouts* admin
  setting once at startup (an existing admin save always wins, and values
  outside the setting's 30s–1h blocking / 24h async bounds are clamped and
  logged) — after that the variable is ignored and every boot reminds you to
  delete it. While cleaning house, the API also warns at startup for each
  legacy `NCA_*` / `WEB_BASE_URL` env alias it finds, and
  `MF_CHAT_STREAM_FLUSH_MS` / `MF_TURN_ADOPT_REPOLL_MS` are documented in
  `.env.example`.

`mf update` pulls the new binary.
