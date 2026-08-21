---
version: '0.13.0'
date: '2026-06-15'
---

## CLI 0.13.0 — Agents can request one missing capability

Runtime agents can ask their owner for a narrowly scoped permission without
replacing their existing grants or seeing a token.

### Highlights

- **Incremental permission grants.** Approval appends the requested scope and
  keeps existing permissions.
- **Owner-controlled consent.** The agent prints a consent URL for its owner;
  the underlying token is never shown.
- **Minimum scope by default.** Agents can request only the capability the
  blocked operation needs.

The current command for this workflow is
`mf auth ensure --scopes <scope-list>`.
