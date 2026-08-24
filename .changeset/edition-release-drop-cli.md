---
'@manyfold/api': patch
---

The edition release (`v*`) no longer carries mf CLI binaries. The CLI has its
own release train (`cli-v*`), so a CLI fix no longer waits for an edition
release, and the edition tag no longer implies a CLI version it never matched.

Install the CLI with `curl -fsSL https://manyfold.ai/cli/install.sh | sh`, or
pick a build from the `cli-v*` releases. Nothing needs to change for existing
installs: the installer resolves a channel manifest, not `releases/latest`.
