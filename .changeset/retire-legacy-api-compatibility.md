---
'@manyfold/cli': major
'@manyfold/web': major
'@manyfold/admin': major
---

Clients now require the canonical Manyfold API contract. `mf whoami` calls
`/auth/whoami` only and reports a missing endpoint instead of retrying
`/auth/me` and constructing a legacy identity response. Login and setup still
use `/auth/me` for their current account flow.

The shared SDK recognizes structured errors only inside the `error` object.
Legacy top-level `code`, `message`, and `details` fields no longer supply error
metadata. HTTP status fallback and raw-response diagnostics remain available;
CLI error output never prints an unparsed response body.

Upgrade self-hosted APIs before deploying these clients. Servers must provide
`/auth/whoami` and the `{ ok: false, error: { code, message, details? } }`
response contract. Existing Agent runtime and external A2A identities are
unchanged.
