import {
    HERMES_DASHBOARD_SERVICE,
    HERMES_PROXY_SERVICE,
    SPRITE_HOME_BASE,
    envTextToRecord,
    isSemverVersionTag
} from '@manyfold/shared'
import { Injectable } from '@nestjs/common'
import { WebSocket } from 'ws'
import { execSprite, spriteWriteFile } from '@manyfold/sprites'
import type { ResolvedHermesCredentials } from '@/modules/agents/credentials/resolved-credentials'
import {
    BootstrapError,
    type BootstrapContext
} from '@/modules/agents/bootstrap/framework-bootstrap'
import {
    buildHermesConfigYaml,
    buildHermesEnv,
    generateHermesApiServerKey,
    hermesProviderAliasEnv,
    HERMES_DASHBOARD_PORT,
    HERMES_PORT,
    HERMES_PROXY_PORT,
    mapHermesProvider
} from '@/modules/agents/bootstrap/hermes-shared'
import { renderHermesFrontProxyScript } from '@/modules/agents/bootstrap/hermes-front-proxy'
import type {
    SpriteServiceBootstrap,
    SpriteServiceBootstrapResult
} from '@/modules/agents/bootstrap/sprite-framework-bootstrap'
import { SpriteKeepAliveLeaseService } from '@/modules/agents/keep-alive/sprite-keepalive-lease.service'
import { generateRuntimeReportToken } from '@/modules/agents/keep-alive/runtime-report-token'

const HERMES_HOME = `${SPRITE_HOME_BASE}/.hermes`
const HERMES_APP_DIR = `${HERMES_HOME}/hermes-agent`
const HERMES_APP_BAK = `${HERMES_APP_DIR}.bak`
const HERMES_BIN = `${HERMES_APP_DIR}/venv/bin/hermes`
// `hermes gateway` is the entry point that exposes the OpenAI-compatible API
// server when API_SERVER_ENABLED=true (NousResearch docs reference/environment-variables.md).
// Bare `hermes` boots the interactive TUI and exits on missing stdin.
const HERMES_GATEWAY_CMD = [HERMES_BIN, 'gateway'] as const
const HERMES_SERVICE_NAME = 'hermes'
const HERMES_KEEPALIVE_TASK = 'hermes-keepalive'
const HERMES_INSTALL_TIMEOUT_MS = 900_000
const HERMES_WEB_DIST_DIR = `${HERMES_APP_DIR}/hermes_cli/web_dist`
const HERMES_PROXY_SCRIPT = `${HERMES_HOME}/mf-front-proxy.mjs`
// `tsc -b && vite build` in <checkout>/web emits straight into
// hermes_cli/web_dist (verified on a sprite 2026-07-03: ~22s + npm install).
// Exported for the framework-upgrade flow: a rebuild replaces the checkout
// and takes web_dist with it.
export const HERMES_WEB_BUILD_TIMEOUT_MS = 600_000
// No explicit `exit 0`: on a login shell with `set -e`, the stock Debian
// ~/.bash_logout (`[ -x /usr/bin/clear_console ] && …` → 1 when absent)
// corrupts an explicit-exit status to 1. Implicit end-of-script is immune
// (verified on a sprite 2026-07-03).
export const HERMES_WEB_BUILD_SHELL = [
    'set -eu',
    `if [ ! -f "${HERMES_WEB_DIST_DIR}/index.html" ]; then`,
    `    cd "${HERMES_APP_DIR}/web"`,
    '    npm install --no-audit --no-fund',
    '    npm run build',
    'fi',
    'echo web_dist_ready'
].join('\n')
const HEALTH_PROBE_ATTEMPTS = 10
const HEALTH_PROBE_INTERVAL_MS = 3_000

// The CalVer tag is interpolated into the installer's `--branch` argument, so
// this is the gate that keeps a shell metacharacter out of it. See the note on
// assertNarraNexusVersion: a valid semver string cannot carry one, which is why
// admitting prereleases here does not widen the shell surface.
// Returns the trimmed value for the same reason as assertNarraNexusVersion: the
// string that was validated is the string that must be interpolated.
const assertHermesVersion = (version: string): string => {
    if (!isSemverVersionTag(version))
        throw new Error(`invalid hermes version "${version}"`)
    return version.trim()
}

// NousResearch publishes the installer at this URL (always fetched from `main`;
// the script itself is version-agnostic). `--skip-setup` skips the interactive
// onboarding wizard (we supply env vars). The git config rewrites switch
// SSH→HTTPS for pip dependencies hitting GitHub from a sprite where outbound SSH
// may be slow or blocked. A `ref` (CalVer tag) pins the CHECKOUT via the
// installer's `--branch`, which `git clone --depth 1 --branch` honours for tags;
// no ref keeps the historical `main` behaviour.
const buildHermesInstallScript = (ref?: string | null): string => {
    const installArgs = ['--skip-setup']
    if (ref) installArgs.push('--branch', assertHermesVersion(ref))
    return [
        'set -eu',
        'git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"',
        'git config --global url."https://github.com/".insteadOf "git@github.com:"',
        `curl --proto '=https' -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- ${installArgs.join(' ')}`
    ].join(' && ')
}

// In-place version upgrade: re-run the installer pinned to a new tag. The old
// checkout is moved aside first so the installer does a clean clone (it would
// otherwise take its in-place "update" path, which can't fast-forward a detached
// tag); on any failure `set -e` aborts and the caller runs the restore shell to
// roll back. Config + sessions live in $HERMES_HOME OUTSIDE hermes-agent/ and are
// left untouched. Caller stops the service before and starts it after.
export const buildHermesRebuildShell = (version: string): string => {
    const tag = assertHermesVersion(version)
    return [
        'set -eu',
        `rm -rf "${HERMES_APP_BAK}"`,
        `if [ -d "${HERMES_APP_DIR}" ]; then mv "${HERMES_APP_DIR}" "${HERMES_APP_BAK}"; fi`,
        buildHermesInstallScript(tag),
        `rm -rf "${HERMES_APP_BAK}"`
    ].join('\n')
}

// Roll back to the pre-upgrade checkout after a failed rebuild.
export const buildHermesRestoreShell = (): string =>
    [
        'set -u',
        `if [ -d "${HERMES_APP_BAK}" ]; then rm -rf "${HERMES_APP_DIR}"; mv "${HERMES_APP_BAK}" "${HERMES_APP_DIR}"; fi`
    ].join('\n')

@Injectable()
export class HermesSpriteBootstrap implements SpriteServiceBootstrap {
    readonly framework = 'hermes' as const

    constructor(private readonly keepAliveLease: SpriteKeepAliveLeaseService) {}

    async run(
        ctx: BootstrapContext,
        credentials: unknown
    ): Promise<SpriteServiceBootstrapResult> {
        const creds = credentials as ResolvedHermesCredentials
        const apiServerKey = generateHermesApiServerKey(creds.apiServerKey)
        const env = this.serviceEnv(ctx, creds, apiServerKey)

        const installVersion = ctx.frameworkVersion ?? null
        ctx.logger.info('hermes.sprite.install.begin', {
            spriteName: ctx.spriteName,
            version: installVersion ?? 'main'
        })
        const install = await execSprite(
            ctx.client,
            ctx.spriteName,
            {
                cmd: ['bash', '-lc', buildHermesInstallScript(installVersion)],
                stdin: '',
                timeoutMs: HERMES_INSTALL_TIMEOUT_MS
            },
            ctx.logger
        )
        if (install.exitCode !== 0)
            throw new BootstrapError(
                'hermes-install',
                `hermes install exited ${install.exitCode}: ${install.stderr.slice(0, 512)}`
            )
        ctx.logger.info('hermes.sprite.install.done', {
            spriteName: ctx.spriteName
        })

        // Write the same config.yaml that docker/hermes/entrypoint.sh would.
        // Without it, Hermes can't resolve the model/provider and emits
        // empty SSE streams ("No inference provider configured" in logs).
        await this.writeConfigYaml(ctx, creds)

        const runtimeReportToken = generateRuntimeReportToken()
        await this.keepAliveLease.install({
            runtimeId: ctx.runtimeId,
            framework: this.framework,
            serviceName: HERMES_SERVICE_NAME,
            client: ctx.client,
            spriteName: ctx.spriteName,
            homeDir: HERMES_HOME,
            exec: [...HERMES_GATEWAY_CMD],
            legacyTaskNames: [HERMES_KEEPALIVE_TASK],
            reportToken: runtimeReportToken,
            logger: ctx.logger
        })

        await this.upsertAndStart(ctx, env, HERMES_PORT)

        // Flip URL auth to public so the chat adapter can reach Hermes via
        // sprite URL without Fly's session-cookie auth wrapper. Hermes's
        // API_SERVER_KEY (Bearer) is the actual auth layer. /v1/health stays
        // unauth'd by Hermes — an acceptable info-disclosure tradeoff.
        await ctx.client.updateSprite(ctx.spriteName, {
            url_settings: { auth: 'public' }
        })

        const sprite = await ctx.client.getSprite(ctx.spriteName)
        const endpointUrl =
            typeof sprite.url === 'string' && sprite.url.length > 0
                ? sprite.url
                : null

        return {
            homeDir: HERMES_HOME,
            serviceName: HERMES_SERVICE_NAME,
            httpPort: HERMES_PORT,
            endpointUrl,
            generatedCredentials: { apiServerKey, runtimeReportToken }
        }
    }

    async restart(ctx: BootstrapContext, credentials: unknown): Promise<void> {
        const creds = credentials as ResolvedHermesCredentials
        const apiServerKey = generateHermesApiServerKey(creds.apiServerKey)
        // config.yaml is what `hermes acp` and the gateway actually read for
        // model/provider — service env alone never reaches an ACP child. A
        // credentials update that skipped this file left agents failing
        // `HTTP 400: model is required` until they were recreated (staging,
        // 2026-07-29).
        await this.writeConfigYaml(ctx, creds)
        const env = this.serviceEnv(ctx, creds, apiServerKey)
        if (ctx.dashboardEnabled) {
            // Dashboard topology holds the public http_port on the proxy;
            // rebuilding only the gateway service would grab the port back
            // (platform allows a single holder) and leave the dashboard/proxy
            // env stale. Re-run the whole dance.
            await this.applyEnabledTopology(ctx, creds, env)
            return
        }
        await ctx.client
            .deleteService(ctx.spriteName, HERMES_SERVICE_NAME)
            .catch(() => undefined)
        await this.upsertAndStart(ctx, env, HERMES_PORT)
    }

    // One writer for provision AND restart, so a credentials update cannot
    // drift from what a fresh agent would have been given.
    private async writeConfigYaml(
        ctx: BootstrapContext,
        creds: ResolvedHermesCredentials
    ): Promise<void> {
        const rawProvider =
            (creds.primaryModelProvider as string | undefined) ?? 'openai'
        const configYaml = buildHermesConfigYaml({
            profile: creds.profile ?? 'default',
            provider: mapHermesProvider(rawProvider),
            modelName: creds.primaryModelName ?? undefined,
            baseUrl: creds.primaryModelBaseUrl ?? undefined,
            apiKey: creds.primaryModelApiKey ?? undefined
        })
        await spriteWriteFile(
            ctx.client,
            ctx.spriteName,
            {
                absPath: `${HERMES_HOME}/config.yaml`,
                body: Buffer.from(configYaml, 'utf8'),
                mode: '644',
                timeoutMs: 30_000
            },
            ctx.logger
        )
    }

    // Enable the native `hermes dashboard` web UI behind the front proxy.
    // Idempotent by design (every step is delete→upsert→start or a guarded
    // exec), so re-running with the flag already on repairs a drifted
    // topology. Caller (facade) must have persisted creds.dashboardToken
    // first. Rollback on failure restores the DISABLED topology — gateway
    // owning the public port — because chat must never be left unroutable.
    async enableDashboard(
        ctx: BootstrapContext,
        credentials: unknown
    ): Promise<void> {
        const creds = credentials as ResolvedHermesCredentials
        if (!creds.dashboardToken)
            throw new BootstrapError(
                'hermes-dashboard-enable',
                'credentials missing dashboardToken — persist it before enabling'
            )
        const apiServerKey = generateHermesApiServerKey(creds.apiServerKey)
        const env = this.serviceEnv(ctx, creds, apiServerKey)

        await this.buildWebUi(ctx)

        try {
            await this.applyEnabledTopology(ctx, creds, env)
            const baseUrl = await this.spriteBaseUrl(ctx)
            await this.probe(
                `${baseUrl}/v1/health`,
                (status) => status === 200,
                'gateway /v1/health via proxy'
            )
            // Security invariant, not a liveness check: the HTML route must
            // reject tokenless requests (hermes injects its session token
            // into index.html for any caller it serves).
            await this.probe(
                `${baseUrl}/`,
                (status) => status === 401,
                'tokenless dashboard root returns 401'
            )
            // Real WS handshake with the PUBLIC origin a browser would send.
            // The dashboard's WS guard closes non-loopback-Origin upgrades
            // before accept() (browser sees 1006) — the proxy must rewrite
            // Origin to loopback for this to pass, and the HTTP probes above
            // can't see that class of breakage.
            await this.probeWs(
                `${baseUrl.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(creds.dashboardToken)}`,
                baseUrl,
                'dashboard /api/ws handshake with browser Origin'
            )
        } catch (err) {
            ctx.logger.warn('hermes.dashboard.enable.rollback', {
                spriteName: ctx.spriteName,
                reason: (err as Error).message
            })
            await this.applyDisabledTopology(ctx, env).catch((rollbackErr) =>
                ctx.logger.error('hermes.dashboard.enable.rollback_failed', {
                    spriteName: ctx.spriteName,
                    reason: (rollbackErr as Error).message
                })
            )
            throw err
        }
    }

    // Two-phase disable: restore the gateway as the public-port holder and
    // PROVE it serves before removing the dashboard. If restoration fails we
    // roll back to the full ENABLED topology (proxy holding the port) — a
    // lingering dashboard beats an unroutable chat path, and a half-state
    // with two http_port claimants is rejected by the platform outright.
    async disableDashboard(
        ctx: BootstrapContext,
        credentials: unknown
    ): Promise<void> {
        const creds = credentials as ResolvedHermesCredentials
        const apiServerKey = generateHermesApiServerKey(creds.apiServerKey)
        const env = this.serviceEnv(ctx, creds, apiServerKey)
        await ctx.client
            .deleteService(ctx.spriteName, HERMES_PROXY_SERVICE)
            .catch(() => undefined)
        try {
            await ctx.client
                .deleteService(ctx.spriteName, HERMES_SERVICE_NAME)
                .catch(() => undefined)
            await this.upsertAndStart(ctx, env, HERMES_PORT)
            const baseUrl = await this.spriteBaseUrl(ctx)
            await this.probe(
                `${baseUrl}/v1/health`,
                (status) => status === 200,
                'gateway /v1/health direct'
            )
        } catch (err) {
            ctx.logger.warn('hermes.dashboard.disable.rollback', {
                spriteName: ctx.spriteName,
                reason: (err as Error).message
            })
            await this.applyEnabledTopology(ctx, creds, env).catch(
                (rollbackErr) =>
                    ctx.logger.error(
                        'hermes.dashboard.disable.rollback_failed',
                        {
                            spriteName: ctx.spriteName,
                            reason: (rollbackErr as Error).message
                        }
                    )
            )
            throw err
        }
        await ctx.client
            .deleteService(ctx.spriteName, HERMES_DASHBOARD_SERVICE)
            .catch(() => undefined)
    }

    // Ordered dance for the enabled topology. The platform allows exactly one
    // http_port holder per sprite (PUT rejects a second), so the gateway must
    // drop the port before the proxy can claim it. Do NOT model this with
    // sprites `needs` — the platform refuses to stop a depended-on service,
    // which would wedge our stop path.
    private async applyEnabledTopology(
        ctx: BootstrapContext,
        creds: ResolvedHermesCredentials,
        gatewayEnv: Record<string, string>
    ): Promise<void> {
        if (!creds.dashboardToken)
            throw new BootstrapError(
                'hermes-dashboard-topology',
                'credentials missing dashboardToken'
            )
        await this.writeProxyScript(ctx)

        await ctx.client
            .deleteService(ctx.spriteName, HERMES_SERVICE_NAME)
            .catch(() => undefined)
        await this.upsertAndStart(ctx, gatewayEnv, undefined)

        await ctx.client
            .deleteService(ctx.spriteName, HERMES_DASHBOARD_SERVICE)
            .catch(() => undefined)
        await ctx.client.upsertService(
            ctx.spriteName,
            HERMES_DASHBOARD_SERVICE,
            {
                cmd: 'bash',
                args: [
                    '-lc',
                    `exec ${HERMES_BIN} dashboard --no-open --skip-build --host 127.0.0.1 --port ${HERMES_DASHBOARD_PORT}`
                ],
                env: {
                    ...gatewayEnv,
                    // The web server must never race the gateway for the API
                    // server port; only the gateway service runs it.
                    API_SERVER_ENABLED: 'false',
                    HERMES_DASHBOARD_SESSION_TOKEN: creds.dashboardToken,
                    HERMES_WEB_DIST: HERMES_WEB_DIST_DIR
                },
                dir: HERMES_HOME
            }
        )
        const dashState = await ctx.client.startService(
            ctx.spriteName,
            HERMES_DASHBOARD_SERVICE
        )
        if (dashState.state.status === 'failed')
            throw new BootstrapError(
                'hermes-dashboard-start',
                `hermes dashboard failed to start: ${dashState.state.error ?? 'unknown'}`
            )

        await ctx.client
            .deleteService(ctx.spriteName, HERMES_PROXY_SERVICE)
            .catch(() => undefined)
        await ctx.client.upsertService(ctx.spriteName, HERMES_PROXY_SERVICE, {
            cmd: 'bash',
            args: ['-lc', `exec node ${HERMES_PROXY_SCRIPT}`],
            env: {
                MF_PROXY_PORT: String(HERMES_PROXY_PORT),
                MF_GATEWAY_PORT: String(HERMES_PORT),
                MF_DASHBOARD_PORT: String(HERMES_DASHBOARD_PORT),
                MF_DASHBOARD_TOKEN: creds.dashboardToken
            },
            dir: HERMES_HOME,
            http_port: HERMES_PROXY_PORT
        })
        const proxyState = await ctx.client.startService(
            ctx.spriteName,
            HERMES_PROXY_SERVICE
        )
        if (proxyState.state.status === 'failed')
            throw new BootstrapError(
                'hermes-proxy-start',
                `hermes front proxy failed to start: ${proxyState.state.error ?? 'unknown'}`
            )
    }

    // Restore the plain single-service topology: gateway holding http_port,
    // no dashboard, no proxy.
    private async applyDisabledTopology(
        ctx: BootstrapContext,
        gatewayEnv: Record<string, string>
    ): Promise<void> {
        await ctx.client
            .deleteService(ctx.spriteName, HERMES_PROXY_SERVICE)
            .catch(() => undefined)
        await ctx.client
            .deleteService(ctx.spriteName, HERMES_DASHBOARD_SERVICE)
            .catch(() => undefined)
        await ctx.client
            .deleteService(ctx.spriteName, HERMES_SERVICE_NAME)
            .catch(() => undefined)
        await this.upsertAndStart(ctx, gatewayEnv, HERMES_PORT)
    }

    private async buildWebUi(ctx: BootstrapContext): Promise<void> {
        const build = await execSprite(
            ctx.client,
            ctx.spriteName,
            {
                cmd: ['bash', '-lc', HERMES_WEB_BUILD_SHELL],
                stdin: '',
                timeoutMs: HERMES_WEB_BUILD_TIMEOUT_MS
            },
            ctx.logger
        )
        if (build.exitCode !== 0)
            throw new BootstrapError(
                'hermes-dashboard-build',
                `hermes web UI build exited ${build.exitCode}: ${build.stderr.slice(0, 512)}`
            )
    }

    private async writeProxyScript(ctx: BootstrapContext): Promise<void> {
        await spriteWriteFile(
            ctx.client,
            ctx.spriteName,
            {
                absPath: HERMES_PROXY_SCRIPT,
                body: Buffer.from(renderHermesFrontProxyScript(), 'utf8'),
                mode: '644',
                timeoutMs: 30_000
            },
            ctx.logger
        )
    }

    private async spriteBaseUrl(ctx: BootstrapContext): Promise<string> {
        const sprite = await ctx.client.getSprite(ctx.spriteName)
        if (typeof sprite.url !== 'string' || sprite.url.length === 0)
            throw new BootstrapError(
                'hermes-dashboard-url',
                `sprite ${ctx.spriteName} has no public URL`
            )
        return sprite.url.replace(/\/+$/, '')
    }

    private async probe(
        url: string,
        ok: (status: number) => boolean,
        label: string
    ): Promise<void> {
        let lastStatus: number | string = 'unreachable'
        for (let attempt = 0; attempt < HEALTH_PROBE_ATTEMPTS; attempt++) {
            try {
                const res = await fetch(url, {
                    signal: AbortSignal.timeout(5_000)
                })
                lastStatus = res.status
                await res.arrayBuffer().catch(() => undefined)
                if (ok(res.status)) return
            } catch {
                lastStatus = 'unreachable'
            }
            await new Promise((resolve) =>
                setTimeout(resolve, HEALTH_PROBE_INTERVAL_MS)
            )
        }
        throw new BootstrapError(
            'hermes-dashboard-probe',
            `probe failed (${label}): last status ${lastStatus} at ${url}`
        )
    }

    // The URL carries the dashboard token as a query param; error messages
    // flow into logs and the persisted dashboard_state, so only the path is
    // ever reported.
    private async probeWs(
        url: string,
        origin: string,
        label: string
    ): Promise<void> {
        let lastReason = 'unreachable'
        for (let attempt = 0; attempt < HEALTH_PROBE_ATTEMPTS; attempt++) {
            try {
                await new Promise<void>((resolve, reject) => {
                    const ws = new WebSocket(url, {
                        origin,
                        handshakeTimeout: 5_000
                    })
                    ws.once('open', () => {
                        ws.terminate()
                        resolve()
                    })
                    ws.once('unexpected-response', (_req, res) => {
                        ws.terminate()
                        reject(
                            new Error(
                                `handshake rejected with status ${res.statusCode}`
                            )
                        )
                    })
                    ws.once('error', (err) => reject(err))
                })
                return
            } catch (err) {
                lastReason = (err as Error).message
            }
            await new Promise((resolve) =>
                setTimeout(resolve, HEALTH_PROBE_INTERVAL_MS)
            )
        }
        throw new BootstrapError(
            'hermes-dashboard-probe',
            `probe failed (${label}): ${lastReason} at ${url.split('?')[0]}`
        )
    }

    private serviceEnv(
        ctx: BootstrapContext,
        creds: ResolvedHermesCredentials,
        apiServerKey: string
    ): Record<string, string> {
        const rawProvider =
            (creds.primaryModelProvider as string | undefined) ?? 'openai'
        return {
            ...envTextToRecord(ctx.envText),
            ...buildHermesEnv({
                creds,
                apiServerKey,
                // Always false for the gateway service: the sprite dashboard
                // is a separate `hermes dashboard` service, never gateway-
                // managed, and flipping this env could trigger unvetted
                // upstream behavior. ctx.dashboardEnabled drives topology and
                // http_port ownership only.
                dashboardEnabled: false
            }),
            // Hermes reads `OPENAI_API_KEY` / `OPENROUTER_API_KEY` / etc. —
            // not `HERMES_PRIMARY_MODEL_API_KEY`. Mirror what
            // docker/hermes/entrypoint.sh re-exports.
            ...hermesProviderAliasEnv(rawProvider, creds.primaryModelApiKey ?? '')
        }
    }

    // Sprite env only propagates via delete→upsert→start; run() calls this after
    // a fresh install (no prior service to delete), restart() deletes first.
    // httpPort is undefined while the dashboard topology is active — the front
    // proxy owns the sprite's single public port then.
    private async upsertAndStart(
        ctx: BootstrapContext,
        env: Record<string, string>,
        httpPort: number | undefined
    ): Promise<void> {
        await ctx.client.upsertService(ctx.spriteName, HERMES_SERVICE_NAME, {
            cmd: 'bash',
            args: ['-lc', `exec ${HERMES_HOME}/start.sh`],
            env,
            dir: HERMES_HOME,
            ...(httpPort !== undefined ? { http_port: httpPort } : {})
        })
        const state = await ctx.client.startService(
            ctx.spriteName,
            HERMES_SERVICE_NAME
        )
        if (state.state.status === 'failed')
            throw new BootstrapError(
                'hermes-start',
                `hermes service failed to start: ${state.state.error ?? 'unknown'}`
            )
    }
}
