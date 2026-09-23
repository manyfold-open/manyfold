---
'@manyfold/api': minor
'@manyfold/web': minor
'@manyfold/admin': minor
'@manyfold/cli': minor
---

Add Pi (pi.dev) as a coding agent framework. Pi agents run on the stateful
sandbox, Kubernetes and self-owned computer (daemon) runtimes, bring an
Anthropic, OpenAI or Google API key or bind a saved provider of any of those
three protocols, and resume their sessions with `pi --session-id` — in chat,
and in the sandbox terminal, whose new messages sync back when you return to
the chat. The chat composer offers a per-message model override from the bound
provider's models, the credentials dialog can move an agent to another
vendor's provider, and `mf agent create --framework pi` takes `--pi-api-key`
with `--pi-provider`. Every runtime takes a gateway base URL, and on a
self-owned computer the bound provider is what each turn uses: Pi's own sign-in
or `models.json` there never takes over, while its settings, skills and
sessions still apply.
