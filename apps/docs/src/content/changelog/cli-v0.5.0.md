---
version: '0.5.0'
date: '2026-05-11'
---

## CLI 0.5.0 — Channel management

This minor release adds CLI support for managing Cloud Agents channels.

### Highlights

- Added the `nca channels` command group.
- Added commands to list, create, inspect, update, delete, test, and register channels.
- Added global agent context support with `--agent-id` and `NCA_AGENT_ID` for channel workflows.

### Notes

- Use `nca update --force --yes` to reinstall the latest standalone binary after the release workflow publishes it.
