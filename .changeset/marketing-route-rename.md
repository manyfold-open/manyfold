---
'@manyfold/web': minor
---

Two marketing pages get names a stranger can read, and permanent redirects
from the old ones.

`/cloud` becomes `/hosted-agents`. A URL travels without the site around it —
a search result, a pasted link — and to this audience a bare "Cloud" means the
paid tier of an open-source product, a reading the footer's Self-hosting link
sat a few centimetres away and confirmed. The page argues something else: a
cloud machine of its own for your agent, signed in with the subscription you
already pay for. The nav and footer label changes with it, because that is
where the misreading actually bit — the address bar is the quieter half.

`/channels` becomes `/agent-channels`. This one was not wrong, only
unresolvable: channels of what, whose? The qualifier answers it. It stays
`channels` rather than becoming `integrations`, which would promise skills,
MCP and A2A as well, or `chat`, which would disown the two issue trackers. The
nav label stays the bare word — a label is always read inside the site that
owns it, so it does not need the qualifier the URL does.

Both old paths 301 to the new ones in apps/web/Caddyfile, query strings
intact, and the caddy contract test holds them there.
