---
'@manyfold/cli': minor
---

Add `mf login --print-auth-url`, a two-step sign-in for coding agents and other callers without an interactive terminal. It prints the sign-in URL and exits (`--json` adds the API URL, profile and the follow-up command); after the user approves, `mf login --auth-code <code>` completes it. Nothing is stored in between. `--no-launch-browser` without a terminal now points to this flow, and the agent guide allows the one-time `mf_auth_` code — never a token — to be passed on.
