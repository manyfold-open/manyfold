---
version: "0.30.1"
date: "2026-09-07"
---

Self-hosted Codex agents can now be pointed at GPT-6 Astra, and at the two
reasoning levels above Extra high.

- **GPT-6 Astra in the model picker.** When an agent runs on your own machine
  and your own Codex sign-in, the daemon reports the model catalog it can
  offer; that list now includes `gpt-6-astra`, so the model shows up in the
  agent's model settings without waiting for a platform provider to carry it.
- **Maximum and Ultra reasoning.** The daemon also reports the reasoning
  levels, which now go up to `max` and `ultra`. Which of them a given model
  actually accepts is decided per model — Astra reaches `ultra`, GPT-5.6 Luna
  stops at `max`, and GPT-5.5 and older stay at Extra high — so the picker will
  not offer your agent a level its model would reject mid-turn.

Nothing changes for agents that use a platform model provider, and no command
or flag changed in this release. Run `mf update` on daemon hosts to pick it up.
