---
version: "0.30.0"
date: "2026-09-03"
---

Switching a chat session to Terminal can now drop you straight into the coding
CLI's own interactive interface, resumed on that same conversation, instead of
at a bare prompt. The chat view and the TUI become two front ends over one
session, and this release is what lets a self-hosted daemon do it.

- **New `pty.command` capability.** The daemon can open a terminal that runs a
  given command as the shell's argv rather than typing it into the pty, so
  there is no guessing whether the prompt is ready yet — and quitting the TUI
  leaves you in the interactive shell you would otherwise have had. A daemon
  on an older CLI says so instead of opening a plain shell under a UI that
  promised a resume.
- **Only the session id travels.** The browser sends the chat session's id and
  the API looks up that session's own recorded CLI reference to build the
  argv, so no caller chooses what runs on your machine.
- **Both directions stay in sync.** What you say in the resumed TUI is folded
  back into the chat view, and messages sent from the chat show up in the TUI.
  Claude Code and Codex are supported; Gemini's resume takes a session index
  rather than an id, so it opens a normal shell.

Run `mf update` on daemon hosts to pick up the capability.
