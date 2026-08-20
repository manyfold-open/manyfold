# Manyfold

Manyfold is a unified agent workspace: create, deploy and operate coding and
conversational agents — OpenClaw, Hermes Agent, Claude Code, Codex, Gemini
CLI and more — from one API, web workbench, admin console and CLI.

This repository is the open-source, self-hostable edition. The hosted cloud
edition at [manyfold.ai](https://manyfold.ai) is built on exactly this code
plus closed commercial modules (billing, managed model supply, growth
tooling) composed in through the seams you can see in this tree (ports,
overlay slots, registries).

## Quick start (self-hosted)

```sh
docker compose -f docker-compose.selfhost.yml up -d
# then open http://localhost:3002/setup
```

The setup page creates your admin account; the default plan is the seeded
unlimited `self_hosted` tier. See `.env.selfhost.example` for the two
required secrets and every optional integration (k8s runtime, backups,
channels, observability).

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
