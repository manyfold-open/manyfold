---
'@manyfold/cli': minor
---

The daemon now waits for the local OpenClaw gateway to answer before it starts an OpenClaw turn. `openclaw acp` and `openclaw gateway call` do not retry a refused connection, so a turn that arrived while the gateway was still booting failed within seconds, or ran without its model choice. The wait uses the turn's handshake budget (30 seconds by default). If the gateway still has not answered, the turn fails with `openclaw gateway did not answer on port <port> within <n>ms`, and nothing dials the gateway.
