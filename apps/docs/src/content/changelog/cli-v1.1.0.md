---
version: "1.1.0"
date: "2026-09-11"
---

The daemon can hold an API key as a runtime account: an `api-key` auth
profile keeps the key in that profile's own credential context on the host
(`<view>/api-key`, mode 0600) and injects it as the vendor's environment
variable for runs bound to the profile; sign-in is refused for such a
profile, and signing out removes the key. Hosts advertise this as the
`auth-api-key.v1` capability; an API that does not see it refuses the create
instead of storing the key elsewhere.

`account.inspect` accepts a `usage` flag so the API can re-read the sign-in
without asking the vendor for usage again; the previous behaviour (usage
included) is the default.

Existing daemon registrations, profiles and workspaces remain valid.
