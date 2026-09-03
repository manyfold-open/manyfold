---
'@manyfold/web': minor
'@manyfold/api': minor
'@manyfold/cli': minor
---

Switching a session to Terminal can now land you straight in the coding CLI's
own interactive interface, resumed on that same conversation, instead of at a
bare prompt. The chat view and the TUI become two front ends over one session.
Works on sandbox and self-hosted (daemon) agents alike; a daemon needs a CLI
new enough to advertise the `pty.command` capability, and one that is not says
so rather than opening a plain shell under a UI that promised a resume.

The command runs as the shell's argv rather than being typed into the pty, so
there is no guessing whether the prompt is ready yet, and quitting the TUI
leaves the interactive shell you would otherwise have had. Only the chat
session id travels from the browser: the API looks up that session's own
recorded reference and builds the argv, so no caller chooses what runs in the
sandbox. Claude Code and Codex are supported; Gemini's resume takes a session
index rather than an id, so it opens a normal shell.

The resumed TUI opens in full-access mode (`--dangerously-skip-permissions` for
Claude Code, `--dangerously-bypass-approvals-and-sandbox` for Codex) and forces
transcript persistence on, so continuing the conversation there stays in sync
with the chat view rather than prompting for every action or silently
discarding what you did. The runtime is already the trust boundary — your own
daemon machine, or an externally-sandboxed sprite.

Codex needs nothing further — it signs in on the sandbox at creation and its
credentials are already on disk. Claude Code's are injected per turn and never
persist, so its TUI has nothing to authenticate with unless you turn on the
new per-sandbox **Model credentials in the terminal**, which is off by default
and separate from the existing terminal switch. It is worth reading before
enabling: anyone who can open that terminal can then read the key, which the
API otherwise only ever returns masked. A runtime-local agent needs no such
opt-in, only its CLI sign-in. When resuming is unavailable the terminal still
opens as a shell and says which of the two things it was missing.
