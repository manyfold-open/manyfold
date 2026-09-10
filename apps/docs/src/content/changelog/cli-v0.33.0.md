---
version: "0.33.0"
date: "2026-09-10"
---

The CLI now uses browser login and runtime permission requests after retirement
of the device-code grant flow.

Use `mf login` for browser login and `mf auth ensure --scopes <list>` when an
agent needs another permission.

External A2A client grants continue to work with their existing target and
revocation rules.
