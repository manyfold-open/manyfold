---
'@manyfold/api': minor
---

Work on a sandbox now keeps it awake for as long as the work runs, not just while its daemon comes up:

- framework version probes, upgrades, diagnostics, and Hermes and OpenClaw agent setup;
- installing a framework on a sandbox or cloud computer;
- MCP and context-document delivery;
- an open terminal, until its tab closes.

Installing or refreshing an agent's context document on a sandbox that has gone to sleep wakes it for the write, instead of failing.

A command whose connection drops while the sandbox wakes is resent once, and the daemon picks up the one already running instead of starting it twice. Cloud computer scripts no longer put secrets in the command's input, which the daemon keeps on disk for up to a day; they travel in its environment instead.
