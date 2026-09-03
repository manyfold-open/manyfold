---
version: "0.29.0"
date: "2026-09-03"
---

The daemon can now tell the runtime page who its coding CLIs are signed in as,
and what those accounts have used. Open a Claude Code, Codex or Gemini CLI
runtime under Settings → Runtimes and the new Account section shows the
signed-in email, organization and plan, the sign-in status, and the vendor's
usage windows with their reset countdowns.

- **New `account.inspect` capability.** The daemon reads the CLI's own
  credential files and calls the vendor usage endpoint itself, so the token
  never leaves your machine — only the response and non-secret identity
  fields do. Daemons on older CLIs show an "update the CLI" prompt on the
  runtime page instead of a probe failure.
- **Sign in from the runtime page.** When nothing usable is signed in, a
  "Sign in" button opens a shell on the machine inline and starts the CLI's
  headless sign-in (`claude auth login --claudeai`,
  `codex login --device-auth`, `NO_BROWSER=true gemini`); closing it
  re-checks the account. The shell carries no agent environment and no
  Manyfold token.
- **macOS note.** Claude and Gemini keep their tokens in the Keychain, which
  the daemon deliberately does not read, so those runtimes show the signed-in
  identity without usage. Codex keeps a file and shows both.

Run `mf update` on daemon hosts to pick up the capability.
