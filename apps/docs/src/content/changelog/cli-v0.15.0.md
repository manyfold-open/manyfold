---
version: '0.15.0'
date: '2026-06-22'
---

## CLI 0.15.0 — Pick a specific mf CLI version for hosts and sandboxes

The runtime host and sandbox detail pages gain an mf CLI version picker, so you can update a host to a specific build instead of only jumping to the latest. Stable and staging builds are surfaced where available, and daemons can pull a cross-channel build in non-production environments.

### Highlights

- **Install a specific mf CLI version.** The runtime host and sandbox detail pages now include a version picker — update a host or sandbox to a chosen mf CLI version, not just the latest.
- **Stable and staging builds, min-version filtered.** In local and staging environments, both stable and staging builds are listed, filtered to the admin-configured minimum CLI version.
- **Cross-channel daemon updates.** In local and staging, a daemon can install a build from another channel (for example, a staging build on a stable daemon) when it runs a CLI that supports the `daemon.update` channel override. Production daemons stay on their own channel.

### Notes

- The version picker lives on the runtime host and sandbox detail pages in the web app.
- Update with `mf update --force --yes`; existing daemons keep working.
