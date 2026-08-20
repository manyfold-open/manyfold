import {
    NARRANEXUS_SPRITE_BASE_WORKING_PATH,
    SPRITE_HOME_BASE,
    defaultFrameworkRepo,
    envTextToRecord,
    frameworkRepoCloneUrl,
    isSemverVersionTag
} from '@manyfold/shared'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { execSprite } from '@manyfold/sprites'
import { publicApiUrlWithApiPrefix } from '@/common/public-api-url'
import {
    BootstrapError,
    type BootstrapContext
} from '@/modules/agents/bootstrap/framework-bootstrap'
import {
    generateNarraNexusGatewayToken,
    NARRANEXUS_PORT,
    type NarraNexusCredentialsInput
} from '@/modules/agents/bootstrap/narranexus-k8s'
import type {
    SpriteServiceBootstrap,
    SpriteServiceBootstrapResult
} from '@/modules/agents/bootstrap/sprite-framework-bootstrap'
import { SpriteKeepAliveLeaseService } from '@/modules/agents/keep-alive/sprite-keepalive-lease.service'
import { generateRuntimeReportToken } from '@/modules/agents/keep-alive/runtime-report-token'

const NARRANEXUS_HOME = `${SPRITE_HOME_BASE}/.narranexus`
const NARRANEXUS_APP_DIR = `${NARRANEXUS_HOME}/app`
// `NARRANEXUS_SPRITE_BASE_WORKING_PATH` = `${SPRITE_HOME_BASE}/.narranexus/data/workspaces` —
// derive the data dir back from it so the install script + env vars stay
// in lock-step with the per-agent path the adapter advertises.
const NARRANEXUS_DATA_DIR = NARRANEXUS_SPRITE_BASE_WORKING_PATH.replace(
    /\/workspaces$/,
    ''
)
const NARRANEXUS_SERVICE_NAME = 'narranexus'
const NARRANEXUS_KEEPALIVE_TASK = 'narranexus-keepalive'

// 5–7 min wall-clock in the probe (apt ffmpeg ~100s + uv sync ~90s +
// vite build ~120s). Cap at 15 min for slow networks / mirror hiccups.
const NARRANEXUS_INSTALL_TIMEOUT_MS = 900_000

// Fallback release tag, used only when no version could be resolved from the
// catalog. Must match a ref that EVERY repo candidate serves — `git ls-remote
// --tags` is the ground truth, NOT `git describe`, whose output can be an
// annotated tag object's internal name (some upstream tags are published that
// way, e.g. `v1.7.13-oss` for the ref `refs/tags/v1.7.13`).
//
// Bumped from v1.7.15 because that tag ignores the managed-trigger env this
// bootstrap injects, so a catalog-unreachable fallback installed a NarraNexus
// that kept running its own schedulers.
// Measured on github [2026-08-12]: `run.sh` gates on NEXUS_EXTERNAL_TRIGGERS at
// v1.15.0 in BOTH candidates (NetMindAI-Open and protagolabs, line 521) and in
// neither at v1.7.15; both also carry docker/Dockerfile.manyfold and
// backend/routes/manyfold/{sync,agents,files,diagnostics}.py at v1.15.0.
//
// Still incomplete: run.sh only consumes MANYFOLD_SYNC_WEBHOOK_URL/TOKEN +
// MANYFOLD_RUNTIME_ID from `1.15.1-rc.1` onwards (measured on github
// [2026-08-12], run.sh:499-509). That tag exists ONLY in protagolabs, and a
// fallback has to be served by every candidate, so it cannot go here. Bump again
// when a tag carrying it lands in both.
//
// Caveat this tag does NOT satisfy: v1.15.0 resolves to different commits in the
// two candidates — NetMindAI-Open 5869502c, protagolabs e2083c28 (measured on
// github [2026-08-12]) — unlike v1.7.15, which was hand-verified as the same
// tree. Switching the source repository therefore changes which code a given
// version number means, not just where it is fetched from.
const NARRANEXUS_VERSION = 'v1.15.0'

// Both clone sites interpolate the tag into a shell command. The admin default
// pin reaches here as a raw string, so this is the gate that stops a pin like
// `1.2.3-;cmd` from running on the sprite. isSemverVersionTag accepts a semver
// prerelease (`1.15.1-rc.1`) and still rejects every one of those: a valid
// semver string is drawn from `[0-9A-Za-z.+-]`, which carries no shell
// metacharacter, and it asserts that charset separately from the pattern.
const assertNarraNexusVersion = (version: string): string => {
    if (!isSemverVersionTag(version))
        throw new Error(`invalid narranexus version "${version}"`)
    // Returns the TRIMMED value: the guard trims before matching, so handing
    // back the raw input would let surrounding whitespace reach the ref name
    // that was never the thing validated.
    return version.trim()
}

// Probe 2026-06-03 (nca-probe-narranexus-20260603-1831):
//   Python 3.13.7, Node 22.20.0, npm 11.12.1, bash 5.2 — all pre-installed
//   ffmpeg, uv — missing, installed below
//   claude 2.1.92 pre-installed; NarraNexus docker pins 2.1.110, repin via npm
//   NOPASSWD sudo + open network policy = clean install path
// Install NarraNexus at a given tag from a given repo candidate (both resolved
// by the caller, from one settings read, so the version on offer and the
// repository cloned cannot disagree). The uv relock fallback is required: newer
// tags ship a uv.lock current uv (≥0.11) refuses to parse (ambiguous
// `aiosignal`, confirmed v1.7.15..v1.8.3) — without it even NARRANEXUS_VERSION
// won't install on the current image.
const narraNexusInstallScript = (version: string, repo: string): string => {
    const tag = assertNarraNexusVersion(version)
    const url = frameworkRepoCloneUrl(repo)
    return [
        'set -eu',
        // 1. system pkg: NarraNexus's Dockerfile.manyfold lists ffmpeg as a hard dep.
        // ffmpeg drags in tzdata/man-db whose post-install scripts hit debconf;
        // without a TTY they fall through Dialog→Readline→Teletype and apt exits.
        // `sudo env VAR=val cmd` sets the env across sudo (sudo strips it otherwise).
        'sudo env DEBIAN_FRONTEND=noninteractive apt-get update -qq',
        'sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg',
        // 2. uv (Astral's installer) — installs to /usr/local/bin under sudo
        "curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sudo -E sh",
        // 3. clone NarraNexus at the tag — shallow, single branch
        `mkdir -p ${NARRANEXUS_HOME}`,
        `git clone --depth 1 --branch "${tag}" "${url}" "${NARRANEXUS_APP_DIR}"`,
        // 4. Python deps + editable install (matches the Dockerfile.manyfold pattern)
        `cd ${NARRANEXUS_APP_DIR}`,
        'uv sync --frozen --no-dev || { echo "uv.lock incompatible with current uv — regenerating from pyproject"; rm -f uv.lock; uv sync --no-dev; }',
        'uv pip install -e .',
        // 5. Frontend Vite build into frontend/dist (FastAPI serves it as static)
        `cd ${NARRANEXUS_APP_DIR}/frontend`,
        'npm ci --no-audit --no-fund',
        'npm run build',
        // 6. Pin claude-code CLI — ≥2.1.197 required for Claude 5 models
        // (Fable 5 / Opus 4.8 / Sonnet 5); sprite image ships 2.1.92.
        // --allow-scripts: npm 12 blocks claude-code's required postinstall
        // (native-binary swap) while still exiting 0 (#438); package-scoped so
        // nothing else's scripts run. Older npms warn-ignore the flag.
        'npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@2.1.197',
        // 7. Prepare data dir (overrides Dockerfile's hard-coded /data via env)
        `mkdir -p ${NARRANEXUS_DATA_DIR}/workspaces ${NARRANEXUS_DATA_DIR}/logs`
    ].join(' && ')
}

const NARRANEXUS_APP_BAK = `${NARRANEXUS_APP_DIR}.bak`

// In-place version upgrade: re-clone the app at a new tag and rebuild. System
// deps (ffmpeg, uv) installed at bootstrap persist on the sprite rootfs, so we
// skip them. The data dir (sqlite + workspaces + logs) lives OUTSIDE the app
// dir and is left untouched. The old app is moved aside first; on any failure
// `set -e` aborts and the caller runs the restore shell to roll back. Caller
// stops the service before and starts it after.
export const buildNarraNexusRebuildShell = (
    version: string,
    repo: string
): string => {
    const tag = assertNarraNexusVersion(version)
    const url = frameworkRepoCloneUrl(repo)
    return [
        'set -eu',
        `rm -rf "${NARRANEXUS_APP_BAK}"`,
        `if [ -d "${NARRANEXUS_APP_DIR}" ]; then mv "${NARRANEXUS_APP_DIR}" "${NARRANEXUS_APP_BAK}"; fi`,
        `mkdir -p "${NARRANEXUS_HOME}"`,
        `git clone --depth 1 --branch "${tag}" "${url}" "${NARRANEXUS_APP_DIR}"`,
        `cd "${NARRANEXUS_APP_DIR}"`,
        // Prefer the committed lock (reproducible), but newer narranexus tags
        // ship a uv.lock that current uv (≥0.11) refuses to parse (ambiguous
        // `aiosignal` source — confirmed across v1.7.15..v1.8.3). Fall back to
        // regenerating the lock from pyproject.toml so a broken upstream lock
        // can't block the upgrade.
        'uv sync --frozen --no-dev || { echo "uv.lock incompatible with current uv — regenerating from pyproject"; rm -f uv.lock; uv sync --no-dev; }',
        'uv pip install -e .',
        `cd "${NARRANEXUS_APP_DIR}/frontend"`,
        'npm ci --no-audit --no-fund',
        'npm run build',
        'npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@2.1.197',
        `mkdir -p "${NARRANEXUS_DATA_DIR}/workspaces" "${NARRANEXUS_DATA_DIR}/logs"`,
        // success — drop the backup
        `rm -rf "${NARRANEXUS_APP_BAK}"`
    ].join('\n')
}

// Roll back to the pre-upgrade app after a failed rebuild.
export const buildNarraNexusRestoreShell = (): string =>
    [
        'set -u',
        `if [ -d "${NARRANEXUS_APP_BAK}" ]; then rm -rf "${NARRANEXUS_APP_DIR}"; mv "${NARRANEXUS_APP_BAK}" "${NARRANEXUS_APP_DIR}"; fi`
    ].join('\n')

@Injectable()
export class NarraNexusSpriteBootstrap implements SpriteServiceBootstrap {
    readonly framework = 'narranexus' as const

    constructor(
        private readonly keepAliveLease: SpriteKeepAliveLeaseService,
        private readonly config: ConfigService
    ) {}

    async run(
        ctx: BootstrapContext,
        credentials: unknown
    ): Promise<SpriteServiceBootstrapResult> {
        const creds = (credentials ?? {}) as NarraNexusCredentialsInput
        const gatewayToken = generateNarraNexusGatewayToken(creds.gatewayToken)
        const runtimeReportToken = generateRuntimeReportToken()
        const env = this.serviceEnv(ctx, creds, gatewayToken, runtimeReportToken)

        const installVersion = ctx.frameworkVersion ?? NARRANEXUS_VERSION
        // The ctx value was resolved alongside `frameworkVersion`, from one
        // settings read, so the tag and the repo it must exist on always agree.
        // The fallback covers ctx builders that never clone (restart, dashboard).
        const installRepo =
            ctx.frameworkRepo ?? defaultFrameworkRepo('narranexus')
        if (!installRepo)
            throw new BootstrapError(
                'narranexus-install',
                'no narranexus repository candidate is declared'
            )
        ctx.logger.info('narranexus.sprite.install.begin', {
            spriteName: ctx.spriteName,
            version: installVersion,
            repo: installRepo
        })
        const install = await execSprite(
            ctx.client,
            ctx.spriteName,
            {
                cmd: [
                    'bash',
                    '-lc',
                    narraNexusInstallScript(installVersion, installRepo)
                ],
                stdin: '',
                timeoutMs: NARRANEXUS_INSTALL_TIMEOUT_MS
            },
            ctx.logger
        )
        if (install.exitCode !== 0)
            throw new BootstrapError(
                'narranexus-install',
                `narranexus install exited ${install.exitCode}: ${install.stderr.slice(0, 512)}`
            )
        ctx.logger.info('narranexus.sprite.install.done', {
            spriteName: ctx.spriteName
        })

        // run.sh detects RUNTIME_MODE=container and exec's uvicorn in foreground
        // after spawning background services (sqlite_proxy, ModulePoller, MCP
        // servers). Keep-alive task keeps the sprite awake while uvicorn is
        // alive — independent of LLM activity, so long-running agent_loops
        // don't get suspended.
        await this.keepAliveLease.install({
            runtimeId: ctx.runtimeId,
            framework: this.framework,
            serviceName: NARRANEXUS_SERVICE_NAME,
            client: ctx.client,
            spriteName: ctx.spriteName,
            homeDir: NARRANEXUS_HOME,
            exec: ['bash', `${NARRANEXUS_APP_DIR}/run.sh`],
            legacyTaskNames: [NARRANEXUS_KEEPALIVE_TASK],
            reportToken: runtimeReportToken,
            logger: ctx.logger
        })

        await this.upsertAndStart(ctx, env)

        // Public URL auth = gateway-token (Bearer); /healthz is auth-free for
        // probes. Matches openclaw/hermes-sprite pattern.
        await ctx.client.updateSprite(ctx.spriteName, {
            url_settings: { auth: 'public' }
        })

        const sprite = await ctx.client.getSprite(ctx.spriteName)
        const endpointUrl =
            typeof sprite.url === 'string' && sprite.url.length > 0
                ? sprite.url
                : null

        return {
            homeDir: NARRANEXUS_HOME,
            serviceName: NARRANEXUS_SERVICE_NAME,
            httpPort: NARRANEXUS_PORT,
            endpointUrl,
            generatedCredentials: { gatewayToken, runtimeReportToken }
        }
    }

    async restart(ctx: BootstrapContext, credentials: unknown): Promise<void> {
        const creds = (credentials ?? {}) as NarraNexusCredentialsInput
        const gatewayToken = generateNarraNexusGatewayToken(creds.gatewayToken)
        // Pre-report-token runtimes (very old provisions) restart without the
        // managed-trigger env and keep their internal schedulers — a rebuild
        // re-provisions the token and flips them over.
        const env = this.serviceEnv(
            ctx,
            creds,
            gatewayToken,
            creds.runtimeReportToken ?? null
        )
        await ctx.client
            .deleteService(ctx.spriteName, NARRANEXUS_SERVICE_NAME)
            .catch(() => undefined)
        await this.upsertAndStart(ctx, env)
    }

    private serviceEnv(
        ctx: BootstrapContext,
        creds: NarraNexusCredentialsInput,
        gatewayToken: string,
        runtimeReportToken: string | null
    ): Record<string, string> {
        // Override the Dockerfile's hard-coded /data paths so sqlite +
        // workspaces + logs all land under sprite $HOME (persistent across
        // suspend/resume). DASHBOARD_BIND_HOST=0.0.0.0 lets the sprite URL
        // proxy reach uvicorn from the host network.
        const env: Record<string, string> = {
            ...envTextToRecord(ctx.envText),
            ENABLE_MANYFOLD_API: '1',
            MANYFOLD_GATEWAY_TOKEN: gatewayToken,
            BASE_WORKING_PATH: `${NARRANEXUS_DATA_DIR}/workspaces`,
            NEXUS_LOG_DIR: `${NARRANEXUS_DATA_DIR}/logs`,
            // sqlite URI for an absolute path needs exactly 4 slashes:
            // `sqlite:` + `//` (empty host) + `/<abs path>`. NARRANEXUS_DATA_DIR
            // already starts with `/`, so the prefix only contributes 3.
            DATABASE_URL: `sqlite:///${NARRANEXUS_DATA_DIR}/nexus.db`,
            DASHBOARD_BIND_HOST: '0.0.0.0',
            RUNTIME_MODE: 'container'
        }
        if (creds.claudeCodeOauthToken)
            env.CLAUDE_CODE_OAUTH_TOKEN = creds.claudeCodeOauthToken
        // Managed-trigger handover: run.sh skips job_trigger +
        // run_channel_triggers (Manyfold automations/channels own the clock
        // and the IM connections) and the manyfold_sync middleware webhooks
        // config changes back. All-or-nothing: with any piece missing,
        // NarraNexus keeps its internal schedulers (pre-handover behavior).
        const apiBaseUrl = this.config.get<string>('PUBLIC_API_BASE_URL')
        if (apiBaseUrl && runtimeReportToken) {
            env.NEXUS_EXTERNAL_TRIGGERS = '1'
            env.MANYFOLD_SYNC_WEBHOOK_URL = `${publicApiUrlWithApiPrefix(apiBaseUrl)}/internal/narranexus-sync/notify`
            env.MANYFOLD_SYNC_WEBHOOK_TOKEN = runtimeReportToken
            env.MANYFOLD_RUNTIME_ID = ctx.runtimeId
        } else {
            ctx.logger.warn('narranexus.sprite.managed-triggers.skipped', {
                runtimeId: ctx.runtimeId,
                reason: apiBaseUrl
                    ? 'runtime report token unavailable'
                    : 'PUBLIC_API_BASE_URL unset'
            })
        }
        return env
    }

    // Sprite env only propagates via delete→upsert→start; run() calls this after
    // a fresh install (no prior service to delete), restart() deletes first.
    private async upsertAndStart(
        ctx: BootstrapContext,
        env: Record<string, string>
    ): Promise<void> {
        await ctx.client.upsertService(
            ctx.spriteName,
            NARRANEXUS_SERVICE_NAME,
            {
                cmd: 'bash',
                args: ['-lc', `exec ${NARRANEXUS_HOME}/start.sh`],
                env,
                dir: NARRANEXUS_APP_DIR,
                http_port: NARRANEXUS_PORT
            }
        )
        const state = await ctx.client.startService(
            ctx.spriteName,
            NARRANEXUS_SERVICE_NAME
        )
        if (state.state.status === 'failed')
            throw new BootstrapError(
                'narranexus-start',
                `narranexus service failed to start: ${state.state.error ?? 'unknown'}`
            )
    }
}
