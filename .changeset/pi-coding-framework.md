---
'@manyfold/api': minor
'@manyfold/web': minor
'@manyfold/admin': minor
'@manyfold/cli': minor
---

Add Pi (pi.dev) as a coding agent framework. Pi agents run on the stateful
sandbox, Kubernetes and self-owned computer (daemon) runtimes, bring an
Anthropic, OpenAI or Google API key or bind a saved provider of any of those
three protocols, and resume their sessions with `pi --session-id`. The chat
composer offers a per-message model override using `provider/model` ids, and
`mf agent create --framework pi` takes `--pi-api-key` with `--pi-provider`.
On a self-owned computer only the vendor's official endpoint is accepted;
sandboxes and Kubernetes also take a gateway base URL.
