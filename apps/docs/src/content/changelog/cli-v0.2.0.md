---
version: '0.2.0'
date: '2026-05-05'
---

## CLI 0.2.0 — Browser login and production defaults

This release improves the first-run CLI experience and makes the standalone binary point at the production Cloud Agents API by default.

### Highlights

- Added browser-based `nca login` with a loopback callback for local machines.
- Added a headless auth-code login path for environments where opening a browser is not practical.
- Switched the default API URL to the production Cloud Agents endpoint.
- Renamed daemon login flows around machine registration language.
- Added the `nca update` self-update command.
- Fixed daemon spawn arguments in Bun-compiled binaries.

### Notes

- This version is the first CLI release backed by Changesets-generated package release notes.
