---
'@manyfold/api': minor
'@manyfold/web': minor
'@manyfold/admin': minor
'@manyfold/cli': minor
---

Add Antigravity CLI (Google's `agy`) as a coding agent framework. Antigravity
CLI agents run on the stateful sandbox, Kubernetes and self-owned computer
(daemon) runtimes and, like the other coding CLIs, take their model either
from a platform provider — a saved or managed provider of the Gemini
protocol, or a Gemini API key, on one of the models agy offers in its API-key
mode — or from agy's own sign-in on the runtime: a Google account, including
a Google AI Pro or Ultra plan, whose Claude and GPT-OSS models the model
picker then lists too. Run `agy` in the agent's terminal to sign in. A
platform provider never touches the runtime's own agy settings or sign-in.
On sandboxes and Kubernetes, agy is installed at the exact release the
Update Center pins, checked against the sha256 its GitHub release publishes,
and its self-updater stays off there, a terminal user's `agy` included.
Conversations resume with `agy --conversation` in chat and in the terminal,
whose new messages sync back to the chat; the sessions panel lists agy's
conversations; a turn cut off by an API restart finishes under its own
message, read back from agy's conversation log; and a conversation can be
handed to herdr 0.9.1 or newer. `mf daemon hooks install` adds agy's session
hook: a conversation started in the terminal joins the chat list when the
terminal closes, and leaving the TUI hands the conversation back.
`mf agent create --framework antigravity-cli` takes `--google-api-key` and
`--agy-model`. agy's own sign-in on a runtime needs the Manyfold CLI from this
release there.
