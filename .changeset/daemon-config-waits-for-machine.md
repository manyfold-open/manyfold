---
'@manyfold/api': minor
---

A saved change to an agent's MCP servers, or to its context document, reaches the machine even when another configuration push is using it. A machine takes one configuration push at a time; the push a save starts used to give up at once when another held the machine (the context document's push, the push after a daemon reconnects, another agent's on the same machine), leaving the change undelivered until the daemon next reconnected. Linking or unlinking a Composio connection started two such pushes together, so one of them was always lost. A save's push now waits for the machine, up to 100 seconds, and `POST /agents/:id/mcp/materialize` waits up to 20 seconds, then answers 409 `DAEMON_CONFIG_BUSY` instead of a 400 whose only sign was its message.
