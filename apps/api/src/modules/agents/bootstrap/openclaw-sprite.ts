import {
    SPRITE_HOME_BASE,
    envTextToRecord
} from '@manyfold/shared'
import { Injectable } from '@nestjs/common'
import { execSprite, spriteWriteFile } from '@manyfold/sprites'
import type { ResolvedOpenclawCredentials } from '@/modules/agents/credentials/resolved-credentials'
import {
    BootstrapError,
    type BootstrapContext
} from '@/modules/agents/bootstrap/framework-bootstrap'
import {
    buildOpenclawConfigJson,
    buildOpenclawEnv,
    canonicalizeOpenclawBaseUrl,
    generateOpenclawGatewayToken,
    OPENCLAW_PORT,
    openclawDefaultWorkspace,
    openclawWireApiFor
} from '@/modules/agents/bootstrap/openclaw-shared'
import type {
    SpriteServiceBootstrap,
    SpriteServiceBootstrapResult
} from '@/modules/agents/bootstrap/sprite-framework-bootstrap'
import { SpriteKeepAliveLeaseService } from '@/modules/agents/keep-alive/sprite-keepalive-lease.service'
import { generateRuntimeReportToken } from '@/modules/agents/keep-alive/runtime-report-token'

const OPENCLAW_HOME = `${SPRITE_HOME_BASE}/.openclaw`
const OPENCLAW_SERVICE_NAME = 'openclaw'
const OPENCLAW_KEEPALIVE_TASK = 'openclaw-keepalive'
const OPENCLAW_INSTALL_TIMEOUT_MS = 300_000
const PLAYWRIGHT_INSTALL_TIMEOUT_MS = 600_000

// Sprite image has Node 22 + npm; install OpenClaw + Playwright chromium.
// Default sprite image has no Chromium; OpenClaw uses it at runtime for
// browser automation.
//
// `npm install -g` puts the binary under `$(npm config get prefix)/bin`
// (e.g. `/.sprite/languages/node/nvm/versions/node/v22.20.0/bin/openclaw`),
// which is NOT on the sprite's default `bash -lc` PATH. Symlink into
// `~/.local/bin/` — that IS on PATH per the sprite image's shell init —
// so `openclaw` resolves when the service runs `exec openclaw`.
const openclawInstallScript = (version?: string | null): string => {
    const spec = version ? `openclaw@${version.replace(/^v/, '')}` : 'openclaw'
    return [
        'set -eu',
        'mkdir -p ~/.local/bin',
        `npm install -g ${spec}`,
        'ln -sf "$(npm config get prefix)/bin/openclaw" ~/.local/bin/openclaw',
        'npx --yes playwright install chromium'
    ].join(' && ')
}

@Injectable()
export class OpenClawSpriteBootstrap implements SpriteServiceBootstrap {
    readonly framework = 'openclaw' as const

    constructor(private readonly keepAliveLease: SpriteKeepAliveLeaseService) {}

    async run(
        ctx: BootstrapContext,
        credentials: unknown
    ): Promise<SpriteServiceBootstrapResult> {
        const creds = credentials as ResolvedOpenclawCredentials
        const gatewayToken = generateOpenclawGatewayToken(creds.gatewayToken)
        const env = this.serviceEnv(ctx, creds, gatewayToken)

        ctx.logger.info('openclaw.sprite.install.begin', {
            spriteName: ctx.spriteName
        })
        const install = await execSprite(
            ctx.client,
            ctx.spriteName,
            {
                cmd: ['bash', '-lc', openclawInstallScript(ctx.frameworkVersion)],
                stdin: '',
                timeoutMs:
                    OPENCLAW_INSTALL_TIMEOUT_MS + PLAYWRIGHT_INSTALL_TIMEOUT_MS
            },
            ctx.logger
        )
        if (install.exitCode !== 0)
            throw new BootstrapError(
                'openclaw-install',
                `openclaw/playwright install exited ${install.exitCode}: ${install.stderr.slice(0, 512)}`
            )
        ctx.logger.info('openclaw.sprite.install.done', {
            spriteName: ctx.spriteName
        })

        await this.writeConfig(ctx, creds, gatewayToken)

        const runtimeReportToken = generateRuntimeReportToken()
        await this.keepAliveLease.install({
            runtimeId: ctx.runtimeId,
            framework: this.framework,
            serviceName: OPENCLAW_SERVICE_NAME,
            client: ctx.client,
            spriteName: ctx.spriteName,
            homeDir: OPENCLAW_HOME,
            exec: ['openclaw', 'gateway'],
            legacyTaskNames: [OPENCLAW_KEEPALIVE_TASK],
            reportToken: runtimeReportToken,
            logger: ctx.logger
        })

        await this.upsertAndStart(ctx, env)

        // See hermes-sprite.ts: sprite URL auth flipped to public so the chat
        // adapter can reach the gateway. OpenClaw's gateway-token (Bearer) is
        // the actual auth layer.
        await ctx.client.updateSprite(ctx.spriteName, {
            url_settings: { auth: 'public' }
        })

        const sprite = await ctx.client.getSprite(ctx.spriteName)
        const endpointUrl =
            typeof sprite.url === 'string' && sprite.url.length > 0
                ? sprite.url
                : null

        return {
            homeDir: OPENCLAW_HOME,
            serviceName: OPENCLAW_SERVICE_NAME,
            httpPort: OPENCLAW_PORT,
            endpointUrl,
            generatedCredentials: { gatewayToken, runtimeReportToken }
        }
    }

    async restart(ctx: BootstrapContext, credentials: unknown): Promise<void> {
        const creds = credentials as ResolvedOpenclawCredentials
        const gatewayToken = generateOpenclawGatewayToken(creds.gatewayToken)
        const env = this.serviceEnv(ctx, creds, gatewayToken)
        await ctx.client
            .deleteService(ctx.spriteName, OPENCLAW_SERVICE_NAME)
            .catch(() => undefined)
        await this.upsertAndStart(ctx, env)
    }

    // The gateway reads `gateway.controlUi.enabled` from openclaw.json (the
    // env var only matters via the K8s entrypoint, which regenerates the
    // config from env — no such layer exists on sprites), so a toggle is a
    // config rewrite + service bounce. Env is kept in sync anyway to avoid
    // a misleading split-brain when debugging.
    async setControlUi(
        ctx: BootstrapContext,
        credentials: unknown,
        enabled: boolean
    ): Promise<void> {
        const creds = credentials as ResolvedOpenclawCredentials
        const gatewayToken = generateOpenclawGatewayToken(creds.gatewayToken)
        const nextCtx: BootstrapContext = { ...ctx, controlUiEnabled: enabled }
        await this.writeConfig(nextCtx, creds, gatewayToken)
        await this.restart(nextCtx, credentials)
    }

    // Write the full openclaw.json mirroring K8s entrypoint.sh —
    // critically, `gateway.http.endpoints.chatCompletions.enabled = true`
    // is what exposes the OpenAI-compatible HTTP `/v1/chat/completions`
    // endpoint that openclaw.adapter.ts calls. Without it the gateway is
    // WebSocket-only and the adapter sees 404.
    private async writeConfig(
        ctx: BootstrapContext,
        creds: ResolvedOpenclawCredentials,
        gatewayToken: string
    ): Promise<void> {
        const workspacePath = openclawDefaultWorkspace(OPENCLAW_HOME)
        const provider =
            (creds.modelProvider as string | undefined) ??
            (creds.inferenceProtocol as string | undefined) ??
            null
        const providerBaseUrl = canonicalizeOpenclawBaseUrl(
            provider,
            creds.baseUrl
        )
        const openclawConfig = buildOpenclawConfigJson({
            gatewayPort: OPENCLAW_PORT,
            gatewayToken,
            workspacePath,
            controlUiEnabled: ctx.controlUiEnabled ?? true,
            // Bind 0.0.0.0 so the sprite platform proxy can reach the gateway
            // from the host network (loopback also works since proxy is in
            // the VM, but 0.0.0.0 matches the K8s deployment).
            bindHost: '0.0.0.0',
            providerBaseUrl,
            providerApiKey: creds.apiKey ?? '',
            wireApi: openclawWireApiFor(provider),
            modelName: creds.primaryModelName
        })
        await spriteWriteFile(
            ctx.client,
            ctx.spriteName,
            {
                absPath: `${OPENCLAW_HOME}/openclaw.json`,
                body: Buffer.from(openclawConfig, 'utf8'),
                mode: '644',
                timeoutMs: 30_000
            },
            ctx.logger
        )
    }

    private serviceEnv(
        ctx: BootstrapContext,
        creds: ResolvedOpenclawCredentials,
        gatewayToken: string
    ): Record<string, string> {
        const workspacePath = openclawDefaultWorkspace(OPENCLAW_HOME)
        return {
            ...envTextToRecord(ctx.envText),
            ...buildOpenclawEnv({
                creds,
                gatewayToken,
                workspacePath,
                controlUiEnabled: ctx.controlUiEnabled ?? true
            }),
            // Point OpenClaw at the config + state we lay down inside
            // OPENCLAW_HOME so it doesn't fall back to its own default paths
            // (which would land outside the agent's home dir).
            OPENCLAW_CONFIG_PATH: `${OPENCLAW_HOME}/openclaw.json`,
            OPENCLAW_STATE_DIR: OPENCLAW_HOME
        }
    }

    // Sprite env only propagates via delete→upsert→start; run() calls this after
    // a fresh install (no prior service to delete), restart() deletes first.
    private async upsertAndStart(
        ctx: BootstrapContext,
        env: Record<string, string>
    ): Promise<void> {
        await ctx.client.upsertService(
            ctx.spriteName,
            OPENCLAW_SERVICE_NAME,
            {
                cmd: 'bash',
                args: ['-lc', `exec ${OPENCLAW_HOME}/start.sh`],
                env,
                dir: OPENCLAW_HOME,
                http_port: OPENCLAW_PORT
            }
        )
        const state = await ctx.client.startService(
            ctx.spriteName,
            OPENCLAW_SERVICE_NAME
        )
        if (state.state.status === 'failed')
            throw new BootstrapError(
                'openclaw-start',
                `openclaw service failed to start: ${state.state.error ?? 'unknown'}`
            )
    }
}
