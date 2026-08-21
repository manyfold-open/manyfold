---
version: '0.22.2'
date: '2026-08-04'
---

## CLI 0.22.2 — Clean A2A help and Apache licensing

This patch keeps the published CLI help readable and makes the distribution's
open-source license explicit.

### Highlights

- **Readable A2A agent guidance.** `mf help a2a --agent` no longer ends with an
  empty code block or stray fence that could swallow the end of the guide in
  Markdown readers.
- **Aligned command examples.** The A2A command reference is aligned after the
  exposure and caller-management commands added in recent releases.
- **Apache-2.0 licensing.** The CLI package metadata and repository now carry
  the same Apache-2.0 license for source and standalone binaries.
