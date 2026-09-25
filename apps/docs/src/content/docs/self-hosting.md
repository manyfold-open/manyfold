---
title: Self-hosting
description: Run the full Manyfold stack on your own infrastructure — install, upgrades, backups, and the operational contract.
order: 1
---
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

> **Warning:** `MF_API_CRYPTO_KEY` is the long-term master key that encrypts
> stored credentials (provider keys, tokens, login-provider secrets) at rest.
> Losing it makes those rows undecryptable, so keep it wherever you keep your
> database backups.

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

Postgres uses the `pgdata` volume. The default single-node upload storage
uses `chat_uploads`, mounted at `/tmp/manyfold-chat-uploads` in the API
container. Recreating or upgrading that container preserves upload bytes
and metadata. Uploads remain transient: the existing one-hour expiration
still applies. Configure `CHAT_UPLOAD_S3_*` for shared storage when running
more than one API container.

## Backups and restore

Back up the database and encryption key together:

```sh
docker compose -f docker-compose.selfhost.yml exec postgres \
    pg_dump -U postgres -Fc manyfold > manyfold-$(date +%Y%m%d).dump
```

1. the Postgres dump, and
2. your `MF_API_CRYPTO_KEY` (a dump without the key has undecryptable
   credential rows).

Restore into a fresh stack: start only `postgres`, `pg_restore` the dump,
then bring up the rest with the same `MF_API_CRYPTO_KEY`.

To preserve uploads that are still within their expiration window, also
copy their bytes and metadata before stopping or replacing the stack:

```sh
docker compose -f docker-compose.selfhost.yml cp \
    api:/tmp/manyfold-chat-uploads ./chat-uploads-backup
```

After the new API is running with its upload volume, restore the directory
contents (including the `.json` metadata files):

```sh
docker compose -f docker-compose.selfhost.yml cp \
    ./chat-uploads-backup/. api:/tmp/manyfold-chat-uploads
```

This copy is also required on the first upgrade from a release that stored
uploads only inside the old API container. Do it before recreating that
container. A normal `docker compose down` retains named volumes;
`down --volumes` deletes both database and upload storage.

## Upgrades and downgrades

Upgrade the API before the CLI, Web, or Admin clients. The validated server
baseline is edition v0.11.0 (API 5.1.0). Current clients require the canonical
API contract: `mf whoami` uses `/api/auth/whoami` without falling back to the
account endpoint, and structured failures use
`{ ok: false, error: { code, message, details? } }`. Older flat error fields are
not interpreted as error metadata. A missing whoami endpoint remains a 404.

Before upgrading the API, update every daemon to CLI 4.6.1 or newer: the API
refuses registration, heartbeats and connections from older daemons.
Installations older than API 4.0.0 must first run API 4.0.0 and complete their
plan, runtime identity, shell and skill migrations. The new release does not run those
one-time migrations during startup or normal runtime operations.

Databases from before the editions journal split, including API 0.51.1,
must complete their original distribution's journal transition before the
API 4.0.0 bridge. That bridge repairs plan assignments; it does not convert
the old journal. If migration reports that the database predates the split,
stop and use the compatible transition release on a backup copy first.
Do not reset the database or mark migration entries as applied to bypass it.

Rename `WEB_BASE_URL` and `NCA_WEB_URL` to `MF_WEB_URL`, and other retired
`NCA_*` API configuration aliases to their `MF_*` equivalents. Save A2A turn
timeouts in Admin settings before removing `A2A_TURN_TIMEOUT_MS`. Replace
`OPENCLAW_FETCH_TIMEOUT_MS` with the separate `OPENCLAW_HEADERS_TIMEOUT_MS`
and `OPENCLAW_STREAM_IDLE_TIMEOUT_MS` settings. Retired API keys that remain
set cause an explicit startup error listing key names only.

Upgrade = move the tree forward and rebuild; migrations apply automatically
before the new API starts:

```sh
git pull
docker compose -f docker-compose.selfhost.yml up -d --build
```

Downgrade is restore-from-backup: migrations are forward-only, so going back
means checking out the older code **and** restoring the database dump taken
before the upgrade.

## Plans and quotas

Every limit an account has — how many agents it can provision, how many
external-API agents, concurrent sandboxes, storage, channels, automations —
comes from the plan its `users.plan_id` points at. The compose stack sets
`MF_DEFAULT_PLAN_ID=self_hosted`, the seeded unlimited tier, so accounts
created on this stack have no practical limits.

Settings → Usage shows the current plan and effective resource limits,
including per-user grants, alongside current usage. It has no checkout or
billing actions. The former Plan & Billing URL redirects to this summary.

`MF_DEFAULT_PLAN_ID` applies **when an account is created** and nowhere else.
An account created before the deployment set it — the released stack that
predates the unlimited plan, or a hand-written compose/Kubernetes manifest
that never passed the variable — landed on the cloud `free` tier and stays
there. The symptom is a quota error naming a plan you never chose:

```
External API limit reached (3 for Free plan)
```

API 4.0.0 is the upgrade bridge for the former one-time plan repair. Later
releases preserve existing plan assignments and do not change them at startup.
Use the admin console's user detail **Plan** card to change an existing
account. To check the current assignment directly:

```sh
docker compose -f docker-compose.selfhost.yml exec postgres \
  psql -U postgres -d manyfold -c \
  "select u.email, u.plan_id, p.max_agents_provisioned
     from users u join plans p on p.id = u.plan_id;"
```

Set `MF_SELFHOST_DEFAULT_PLAN_ID` in `.env` to put new accounts on a
different seeded plan (`free`, `hobby`, `plus`, `pro`) instead.

## Serving beyond localhost

Two things must change when browsers reach the stack from anywhere but the
machine it runs on:

- **Baked URLs.** The web and admin bundles bake the API base URL at build
  time. Set `MF_SELFHOST_API_URL` (plus the `MF_SELFHOST_*_URL` variables) to
  the URLs browsers will use, then rebuild (`up -d --build`).
- **CORS.** The compose default permits only the configured Web and Admin
  URLs, or `http://localhost:3002,http://localhost:3001` when unset.
  Use origin-only URLs (scheme, host and port, without a path or trailing
  slash). Set `MF_SELFHOST_CORS_ORIGIN` explicitly for additional origins,
  e.g. `https://app.example.com,https://admin.example.com`.

Terminate TLS in your reverse proxy of choice and forward to the three
ports; the API needs WebSocket forwarding (daemon connections and terminals
ride WS).

## Email (SMTP)

Email is runtime configuration, not env: Admin → Settings → Email provider
takes the SMTP host, port, and TLS mode, and everything that sends mail
(sign-up verification, invites) uses it. Without a provider configured the
features that need mail say so instead of failing silently.

Both SMTP modes require encryption: implicit TLS (usually port 465), or
STARTTLS (usually port 587). If STARTTLS is unavailable or fails, no password
or message is sent. Passwords preserve leading and trailing whitespace;
leaving the password blank keeps the stored credential.

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

- **`mf daemon` (default)** — install the [CLI](/docs/install/), then
  `mf login --api-url https://<your-api>/api` and `mf setup` on any machine
  you own. [CLI and daemons on a self-hosted deployment](/docs/self-hosting-cli/)
  walks the whole flow; [Local daemons](/docs/local-daemons/) covers
  registration in detail.
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

## Chat Runner Requirements

Claude Code, Codex, Gemini CLI, OpenClaw and Hermes chat require a connected mf daemon runner. Update older daemons with `mf update` and restart them. For Kubernetes, update the runtime image while preserving its PVC. OpenClaw and Hermes images must run the gateway and daemon together. `PUBLIC_API_BASE_URL` must be reachable from the runtime. Missing or outdated runners produce an explicit error; chat does not switch to direct runtime execution. Dify, Langflow and A2A continue to use their external APIs.
