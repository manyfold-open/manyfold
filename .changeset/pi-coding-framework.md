---
'@manyfold/api': minor
'@manyfold/web': minor
'@manyfold/admin': minor
'@manyfold/cli': minor
---

Add Pi (pi.dev) as a coding agent framework. Pi agents run on the stateful
sandbox, Kubernetes and self-owned computer (daemon) runtimes and, like the
other coding CLIs, take their model either from a platform provider — a saved
or managed provider of the Anthropic, OpenAI or Google protocol, or a vendor
API key — or from Pi's own sign-in on the runtime: the machine's own `pi`
configuration, or a runtime account added from the create flow or the runtime
page (run `pi` and use `/login` for a Claude Pro/Max, ChatGPT Plus/Pro or
Copilot subscription, or an API key). Sessions resume with `pi --session-id`
in chat and in the terminal, whose new messages sync back to the chat, and
`mf daemon hooks install` adds Pi's session hook, an extension Pi loads on its
own: leaving the TUI hands the conversation back, and a session started in the
terminal joins the chat list when the terminal closes. A Pi turn cut off by an
API restart finishes under its own message, read back from Pi's session file
when the runner's stream cannot be picked up again. The composer switches
between the provider's models and the ones `pi --list-models` offers locally,
the credentials dialog can move an agent to another vendor's provider, the
four-step create flow lists Pi, and `mf agent create --framework pi` takes
`--pi-api-key` with `--pi-provider`. A platform provider is what every turn
uses on any runtime, gateways included: Pi's own sign-in or `models.json` on a
machine never takes its place, while Pi's settings, skills and sessions still
apply. Pi's own sign-in on a runtime needs the Manyfold CLI from this release
there.
