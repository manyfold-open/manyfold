---
'@manyfold/api': minor
'@manyfold/web': minor
'@manyfold/cli': minor
---

Show the signed-in account and its usage on the runtime page, and sign in from there.

The runtime detail page (`/settings/runtimes/<runtimeId>`) gains an Account section for Claude Code, Codex and Gemini CLI runtimes on self-owned machines and sandboxes: the signed-in identity (email, organization, plan), the sign-in status, and the subscription usage windows with their reset countdowns (Claude 5h/7d, Codex primary/secondary, Gemini per-model quota). The host reads the CLI's own credential files and calls the vendor usage endpoint itself; only the response and non-secret identity fields ever leave the machine.

- CLI daemon: new `account.inspect` RPC, advertised through the `account.inspect` client feature. Runtime pages of daemons on older CLIs show an update prompt instead of a probe failure.
- API: `GET /agent-runtimes/:id/account` (`?wake=1` to probe a sleeping sandbox, which starts the VM and reserves an active slot), plus a `runtimeId` target on the terminal websocket for a bare host shell.
- Web: when the runtime is not signed in, "Sign in" opens an inline terminal on the host that starts the CLI's own headless sign-in (`claude auth login --claudeai`, `codex login --device-auth`, `NO_BROWSER=true gemini`); closing it re-checks the account. The chat sign-in card now recommends `claude auth login --claudeai` too.
- On macOS machines the Claude and Gemini tokens live in the Keychain, which the daemon deliberately does not read, so identity shows but usage does not.
