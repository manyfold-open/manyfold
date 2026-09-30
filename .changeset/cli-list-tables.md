---
'@manyfold/cli': minor
---

List commands print an aligned table with a header row: `mf channels list`, `mf channels sessions scopes` and `sessions list`, `mf agent list`, `mf runtime list`, `mf automations list`, `mf skills library list`, `mf sandbox list` and `mf model-providers list`. Before, each printed space-separated values with no header, so a label with spaces in it shifted every column after it. `sessions list` names each session's state (`active`, `inactive`, `archived`) instead of a glyph. Chinese and other wide text lines up too. `--json` is unchanged and remains the format for scripts.
