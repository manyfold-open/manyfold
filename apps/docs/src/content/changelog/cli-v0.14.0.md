---
version: '0.14.0'
date: '2026-06-18'
---

## CLI 0.14.0 — Agent health & diagnostics commands removed

The low-value agent diagnostics surface is retired across the platform. The CLI drops the `mf agent diagnose` and `mf agent health-check` commands; agent storage reporting stays exactly as it was.

### Highlights

- **Removed `mf agent diagnose`.** The agent diagnostics probe — and the API endpoint behind it — is gone.
- **Removed `mf agent health-check`.** The agent health-check command — and the API endpoint behind it — is gone.
- **`mf agent storage-usage` is unchanged.** Storage reporting (and the web Storage tab) works exactly as before.

### Notes

- These commands backed the Health, Diagnostics, and Extras tabs in the web agent settings, which are removed in the same release.
- Update with `mf update --force --yes`; existing daemons keep working.
