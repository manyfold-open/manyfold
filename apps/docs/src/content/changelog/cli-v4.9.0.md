---
version: '4.9.0'
date: '2026-09-26'
---

The daemon detects Antigravity CLI (`agy`) and reports its version. An
Antigravity CLI agent can use agy's own sign-in on the machine, a Google
account or a Gemini API key, as its Local model source; the model picker
then lists the models `agy models` offers there, including a Google AI
plan's Claude and GPT-OSS models.

`mf agent create --framework antigravity-cli` creates one, with
`--google-api-key` for a platform key and `--agy-model` for its model.

`mf daemon hooks install` also installs agy's session hook, a
`manyfold-session` block in `~/.gemini/config/hooks.json` next to any other
blocks there. A conversation started in a Manyfold terminal joins the chat
list when the terminal closes, and leaving agy hands a resumed conversation
back to the chat. agy conversations can be handed to herdr 0.9.1 or newer.
