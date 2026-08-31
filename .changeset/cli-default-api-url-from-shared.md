---
---

No CLI behaviour change: `DEFAULT_API_URL` moves to `@manyfold/shared` and the
CLI reads it from there. The string is identical, so a fresh binary still
defaults to the hosted API exactly as before. The move exists for the web,
which needs the same value to decide whether a connect command has to spell
`--api-url` out — two copies would drift while both kept looking right.
