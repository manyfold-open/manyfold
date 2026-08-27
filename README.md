# Manyfold

Manyfold is a unified agent workspace: create, deploy and operate coding and
conversational agents — OpenClaw, Hermes Agent, Claude Code, Codex, Gemini
CLI and more — from one API, web workbench, admin console and CLI.

This repository is the open-source, self-hostable edition. The hosted cloud
edition at [manyfold.ai](https://manyfold.ai) is built on exactly this code
plus closed commercial modules (billing, managed model supply, growth
tooling) composed in through the seams you can see in this tree (ports,
overlay slots, registries).

**New here?** The quick start below brings up a full stack locally in a couple
of minutes; [the docs](https://docs.manyfold.ai) cover everything after that.

## Quick start (self-hosted)

```sh
cp .env.selfhost.example .env
# set the two required secrets in .env:
#   MF_API_CRYPTO_KEY   — openssl rand -base64 32
#   MF_AUTH_SETUP_TOKEN — any one-time secret for the first run
docker compose -f docker-compose.selfhost.yml up -d --build
```

Then open **<http://localhost:3001/setup>** — the admin console, where the
setup token creates your admin account and sign-in methods. The workspace is
at <http://localhost:3002>. New accounts land on the seeded unlimited
`self_hosted` plan; an account created before your deployment set that default
is moved off the `free` tier once, on the next API start, and can be changed
any time from the admin's user detail page.

`MF_API_CRYPTO_KEY` encrypts stored credentials at rest; keep it wherever you
keep your database backups, because a dump without it has undecryptable rows.
`.env.selfhost.example` documents every optional integration (Kubernetes
runtime, backups, channels, observability).

## The CLI

`mf` drives the same API from a terminal, and runs the daemon that lets agents
execute on machines you own. Point it at the stack you just started:

```sh
curl -fsSL https://manyfold.ai/cli/install.sh | sh
mf setup --api-url http://localhost:2222/api
```

`--api-url` is not optional here: the binary's built-in default is the hosted
service at `api.manyfold.ai`, so a bare `mf setup` would enrol this machine
there instead of in your deployment. [CLI and daemons on a self-hosted
deployment](https://docs.manyfold.ai/docs/self-hosting-cli/) covers profiles,
admin-issued tokens and updates.

## Documentation

Full docs at **[docs.manyfold.ai](https://docs.manyfold.ai)** (also in
[Chinese](https://docs.manyfold.ai/zh/docs/self-hosting/)). Roughly the order
you need them in:

| Guide                                                                                               | What it covers                    |
| --------------------------------------------------------------------------------------------------- | --------------------------------- |
| [Self-hosting](https://docs.manyfold.ai/docs/self-hosting/)                                         | Run the stack, upgrades, backups  |
| [CLI and daemons on a self-hosted deployment](https://docs.manyfold.ai/docs/self-hosting-cli/)      | Point `mf` at your own deployment |
| [Register a self-owned computer](https://docs.manyfold.ai/docs/local-daemons/)                      | Attach a machine as a runtime     |
| [Create your first agent](https://docs.manyfold.ai/docs/getting-started/)                           | Models, workspace, chat           |
| [Install the CLI](https://docs.manyfold.ai/docs/install/)                                           | `mf` on macOS, Linux, Windows     |
| [CLI reference](https://docs.manyfold.ai/docs/cli/reference/)                                       | Every command and flag            |
| [Chat API](https://docs.manyfold.ai/docs/api-chat/) · [A2A](https://docs.manyfold.ai/docs/api-a2a/) | Call agents from your own code    |

## Development

```sh
just bootstrap   # install deps, start postgres, run migrations
just dev         # api :2222, web :3002, admin :3001
```

`AGENTS.md` documents the workspace layout and conventions; `justfile` lists
every task. All checks: `pnpm check && pnpm lint && pnpm knip`.

## Contributing

This repository is the single source of truth for the Manyfold core — every
core change, including from the Manyfold team, lands here as a public PR.
Start with [CONTRIBUTING.md](./CONTRIBUTING.md); [GOVERNANCE.md](./GOVERNANCE.md)
explains how the editions relate, and [SECURITY.md](./SECURITY.md) how to
report vulnerabilities privately.

## License

[Apache License 2.0](./LICENSE).
