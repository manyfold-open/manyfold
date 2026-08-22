---
title: Self-hosting
description: Run the full Manyfold stack on your own infrastructure — install, upgrades, backups, and the operational contract.
order: 1
---

# Self-hosting Manyfold

The open-source edition runs the complete stack — API, web workspace, admin
console — from one Docker Compose file. Execution environments are brought by
you: run `mf daemon` on machines you own, connect a Kubernetes cluster, or
paste a sprites.dev account token in the admin.

## Install

```sh
git clone https://github.com/manyfold-open/manyfold.git
cd manyfold
cp .env.selfhost.example .env
# set the two required values in .env:
#   MF_API_CRYPTO_KEY   — openssl rand -base64 32
#   MF_AUTH_SETUP_TOKEN — any one-time secret for the first-run setup
docker compose -f docker-compose.selfhost.yml up -d --build
```

Then open `http://localhost:3001/setup`, enter the setup token, create the
admin account and choose the sign-in methods; the workspace is at
`http://localhost:3002`. New accounts land on the seeded unlimited
`self_hosted` plan.

`MF_API_CRYPTO_KEY` is the long-term master key that encrypts stored
credentials (provider keys, tokens, login-provider secrets) at rest. Losing
it makes those rows undecryptable — keep it wherever you keep your database
backups.

## What runs

| Service | Image | Role |
| --- | --- | --- |
| `postgres` | `postgres:16` | The only datastore (no Redis) |
| `api-migrate` | built from `apps/api/Dockerfile` | One-shot: applies database migrations, then exits |
| `api` | same image as `api-migrate` | NestJS API on `:2222`, path prefix `/api` |
| `web` | built from `apps/web/Dockerfile` | User workspace on `:3002` |
| `admin` | built from `apps/admin/Dockerfile` | Admin console on `:3001` |

## Start order and migrations

Compose encodes the contract: `api-migrate` runs the migration journal to
completion before the `api` service starts, and `web`/`admin` wait for the
API health check. Migrations are forward-only and idempotent — re-running
the stack re-applies nothing. You never run SQL by hand.

## Health

`GET /api/health` returns `{"status":"ok","db":"ok",...}` and is what the
compose health check probes. Point your own monitoring at the same URL.

## Data and volumes

Everything durable lives in Postgres (`pgdata` volume). With the default
`CHAT_UPLOAD_ALLOW_DISK=true`, transient chat-upload bytes may also touch the
API container's disk; configure the `CHAT_UPLOAD_S3_*` variables to move
uploads to any S3-compatible bucket instead (required if you ever run more
than one API container).

## Backups and restore

Back up two things together:

```sh
docker compose -f docker-compose.selfhost.yml exec postgres \
    pg_dump -U postgres -Fc manyfold > manyfold-$(date +%Y%m%d).dump
```

1. the Postgres dump, and
2. your `MF_API_CRYPTO_KEY` (a dump without the key has undecryptable
   credential rows).

Restore into a fresh stack: start only `postgres`, `pg_restore` the dump,
then bring up the rest with the same `MF_API_CRYPTO_KEY`.

## Upgrades and downgrades

Upgrade = move the tree forward and rebuild; migrations apply automatically
before the new API starts:

```sh
git pull
docker compose -f docker-compose.selfhost.yml up -d --build
```

Downgrade is restore-from-backup: migrations are forward-only, so going back
means checking out the older code **and** restoring the database dump taken
before the upgrade.

## Serving beyond localhost

Two things must change when browsers reach the stack from anywhere but the
machine it runs on:

- **Baked URLs.** The web and admin bundles bake the API base URL at build
  time. Set `MF_SELFHOST_API_URL` (plus the `MF_SELFHOST_*_URL` variables) to
  the URLs browsers will use, then rebuild (`up -d --build`).
- **CORS.** With `CORS_ORIGIN` unset the API reflects any origin (fine on
  localhost). When exposing the API, set `MF_SELFHOST_CORS_ORIGIN` to the
  exact web + admin origins, e.g.
  `https://app.example.com,https://admin.example.com`.

Terminate TLS in your reverse proxy of choice and forward to the three
ports; the API needs WebSocket forwarding (daemon connections and terminals
ride WS).

## Email (SMTP)

Email is runtime configuration, not env: Admin → Settings → Email provider
takes the SMTP host, port, and TLS mode, and everything that sends mail
(sign-up verification, invites) uses it. Without a provider configured the
features that need mail say so instead of failing silently.

## Account deletion

Deletion is admin-only: Admin → Users → user detail → Danger zone.
Requesting a deletion deactivates the account immediately — every session is
revoked, sign-in is blocked on all providers, automations are paused,
keep-alive stops — and the user gets an email with the final deletion date.

The hard delete runs after a grace window (default 30 days,
`MF_DELETION_GRACE_DAYS`). During the grace period an admin can restore the
account: the sign-in block is lifted, but automations stay paused until
re-enabled. "Execute now" skips the remaining wait behind a second
confirmation.

When the deadline passes, a background sweep first tears down the user's
runtimes (sandbox VMs are deleted, Kubernetes namespaces removed; daemon
machines are the user's own — their files are untouched, only the tokens
die) and channel registrations, then deletes the user row, which removes
every user-owned table via `ON DELETE CASCADE`. Self-hosted installs run
exactly that: pure cascade plus the sign-in gates, with no billing hooks.
The `user_deletions` audit row (bare user id, no PII) survives the delete
as the durable record; a failed sweep records its error there and retries
automatically.

## Execution environments

Agents run on computers you attach, three ways:

- **`mf daemon` (default)** — install the [CLI](../install/), then
  `mf login --api-url https://<your-api>/api` and `mf setup` on any machine
  you own. See [Local daemons](../local-daemons/).
- **Kubernetes** — add a kubeconfig in the API env to run gateway/cronjob-class
  frameworks; deploy the in-cluster exec gateway with the Helm chart at
  `apps/k8s-gateway/helm/manyfold-k8s-gateway` (its README covers the
  `MF_K8S_GATEWAY_URL` / `MF_K8S_GATEWAY_TOKEN` wiring).
- **sprites.dev** — Admin → Infrastructure → Stateful sandbox accounts:
  paste a sprites.dev account token to run coding agents on rented VMs;
  concurrency follows the account's vendor limits.

## Key rotation

Rotate `MF_API_CRYPTO_KEY` by moving the old key to `API_CRYPTO_KEY_V0`
(decrypt-only) and setting the new key as `API_CRYPTO_KEY`. Keep the old key
configured until no stored row still records key version 0; the
`.env.example` in the repo documents the same flow for non-compose runs.
