---
version: "0.23.2"
date: "2026-08-20"
---

Maintenance release with two housekeeping changes:

- **Dev-channel endpoints are baked in at build time.** Official release builds
  behave exactly as before, while builds produced without those endpoints —
  such as open-source builds — now clearly report that no dev update channel is
  available instead of pointing at a deployment-private host.
- **Removed a stray MIT `LICENSE` file from the CLI package.** The CLI's terms
  are unchanged — Apache-2.0, as the repository's root license states — the
  published tree just no longer carries two conflicting license files.
