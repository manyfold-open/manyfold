---
title: "mf setup"
description: "One-command onboarding: sign in, register this machine as a daemon, start it"
order: 2
---
**用法:** `mf setup [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--api-url <url>` | API base URL |
| `--token <token>` | sign in with an existing user token instead of the browser ("-" reads stdin) |
| `--name <name>` | machine name shown in the dashboard (default: hostname) |
| `--system` | install the daemon at system scope (boot-time; needs root/sudo; default as root) |
| `--user` | install the daemon at user scope (per-login; default as non-root) |
| `--no-launch-browser` | print the auth URL and prompt for the auth code instead of launching a browser (use over SSH) |
| `-h, --help` | display help for command |
