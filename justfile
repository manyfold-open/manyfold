set shell := ['bash', '-cu']
set dotenv-load := false

IMAGE_VERSION := `node -p "require('./package.json').version || '0.0.0'" 2>/dev/null || echo 0.0.0`
IMAGE_DATE := `date -u +%Y%m%d`
IMAGE_SHA := `git rev-parse --short HEAD 2>/dev/null || echo nogit`
IMAGE_TAG := IMAGE_VERSION + "-" + IMAGE_DATE + "-" + IMAGE_SHA

default:
    @just --list

install:
    pnpm install

env:
    [ -f apps/api/.env ] || cp apps/api/.env.example apps/api/.env
    [ -f apps/admin/.env ] || cp apps/admin/.env.example apps/admin/.env
    [ -f apps/web/.env ] || cp apps/web/.env.example apps/web/.env

db-up:
    docker compose up -d postgres
    docker compose exec -T postgres pg_isready -U postgres -d nca >/dev/null 2>&1 || sleep 2

db-down:
    docker compose down

db-reset:
    docker compose down -v
    just db-up

db-generate:
    pnpm db:generate

db-migrate: env
    pnpm db:migrate

db-studio:
    pnpm db:studio

db-psql:
    docker compose exec postgres psql -U postgres -d nca

bootstrap: install env db-up db-generate db-migrate
    @echo 'ready. run: just dev'

dev:
    pnpm dev

dev-api:
    pnpm dev:api

dev-admin:
    pnpm dev:admin

dev-web:
    pnpm dev:web

dev-web-remote ENV="prod":
    @case "{{ENV}}" in \
        http*) VITE_API_URL=/api MF_DEV_API_TARGET={{ENV}} pnpm --filter @manyfold/web dev ;; \
        *) echo 'ENV must be prod, staging, or an API base URL' >&2; exit 1 ;; \
    esac

dev-cli:
    pnpm dev:cli

build:
    pnpm build

cli-build:
    pnpm --filter @manyfold/cli build

cli-link: cli-build
    cd apps/cli && pnpm link --global

cli *ARGS: cli-build
    MF_API_URL=http://localhost:2222/api node apps/cli/dist/index.js {{ARGS}}

cli-clean:
    rm -rf apps/cli/dist

docs-dev:
    pnpm --filter @manyfold/docs dev

docs-build:
    pnpm --filter '@manyfold/docs...' build

# Re-export the og:image social cards from apps/web/scripts/og into both apps.
# Only needed when the card art or the hero copy it mirrors changes. Renders in
# the pinned linux/amd64 Playwright image, which is the one runtime the
# committed bytes come from, so it needs Docker. Set CHROME to a Chromium
# executable to render natively instead — that wins, and produces bytes for
# review that `pnpm social-card:check` will not accept as committed art.
og-render:
    pnpm --filter @manyfold/web exec tsx scripts/og/canonical.ts

# Re-render through the same pinned runtime and diff against the committed
# cards, without writing to the worktree. `pnpm social-card:check` is the
# browser-free gate CI runs.
og-verify:
    pnpm --filter @manyfold/web exec tsx scripts/og/canonical.ts --verify

cli-binary TARGET: cli-build
    pnpm --filter @manyfold/cli exec node scripts/build-binary.mjs {{TARGET}}

cli-binary-host: cli-build
    @ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/'); \
        OS=$(uname -s | tr '[:upper:]' '[:lower:]'); \
        T="bun-$OS-$ARCH"; \
        echo "building $T"; \
        pnpm --filter @manyfold/cli exec node scripts/build-binary.mjs $T
check:
    pnpm check

lint:
    pnpm lint

lint-fix:
    pnpm lint:fix

# 死代码 / 幽灵依赖扫描（unused files/exports/deps + unlisted deps）
knip:
    pnpm knip

e2e-staging *ARGS:
    pnpm e2e:staging {{ARGS}}

e2e-staging-report *ARGS:
    pnpm e2e:staging:report {{ARGS}}

e2e-staging-full *ARGS:
    pnpm e2e:staging --suite smoke {{ARGS}}
    pnpm e2e:staging --suite codex-main {{ARGS}}
    pnpm e2e:staging --suite openclaw-main {{ARGS}}
    pnpm e2e:staging --suite signup-journey {{ARGS}}
    pnpm e2e:staging --suite topup {{ARGS}}

format:
    pnpm format

format-check:
    pnpm format:check

health:
    curl -sSf http://localhost:2222/api/health | jq .

image-tag:
    @echo {{IMAGE_TAG}}

docker-build-base TAG="debian-bookworm":
    docker build -t mf-runtime-base:{{TAG}} docker/mf-base

docker-build-openclaw TAG=IMAGE_TAG: docker-build-base
    docker build -t openclaw:{{TAG}} -t openclaw:latest docker/openclaw

docker-build-hermes TAG=IMAGE_TAG: docker-build-base
    docker build -t hermes:{{TAG}} -t hermes:latest docker/hermes

docker-build-claude-code TAG=IMAGE_TAG: docker-build-base
    docker build -t claude-code:{{TAG}} -t claude-code:latest docker/claude-code

docker-build-codex TAG=IMAGE_TAG: docker-build-base
    docker build -t codex:{{TAG}} -t codex:latest docker/codex

docker-build-gemini-cli TAG=IMAGE_TAG: docker-build-base
    docker build -t gemini-cli:{{TAG}} -t gemini-cli:latest docker/gemini-cli

clean:
    rm -rf node_modules apps/*/node_modules packages/*/node_modules apps/*/dist packages/*/dist .turbo
