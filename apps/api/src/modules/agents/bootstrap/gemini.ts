import { OFFICIAL_PROVIDER_BASE_URL } from '@manyfold/shared'
import { execSprite } from '@manyfold/sprites'
import { Injectable } from '@nestjs/common'
import type { ResolvedGeminiCliCredentials } from '@/modules/agents/credentials/resolved-credentials'
import {
    BootstrapError,
    type BootstrapContext,
    type BootstrapResult,
    type FrameworkBootstrap
} from '@/modules/agents/bootstrap/framework-bootstrap'
import { extractHomeDir } from '@/modules/agents/bootstrap/home-probe'
import { installFrameworkVersion } from '@/modules/agents/bootstrap/framework-version-install'
import { SkillMaterializerService } from '@/modules/skills/skill-materializer.service'
import {
    AgentContextDocService,
    spriteContextDocRunner
} from '@/modules/agent-self/agent-context-doc.service'
import { shellQuote } from '@/modules/agents/workspace/workspace-preflight'

@Injectable()
export class GeminiCliBootstrap implements FrameworkBootstrap {
    readonly framework = 'gemini-cli' as const

    constructor(
        private readonly skills: SkillMaterializerService,
        private readonly agentContext: AgentContextDocService
    ) {}

    async run(
        ctx: BootstrapContext,
        credentials: unknown
    ): Promise<BootstrapResult> {
        const creds = credentials as ResolvedGeminiCliCredentials

        const setup = await execCapturing(ctx, 'gemini-setup-dirs', [
            'bash',
            '-lc',
            [
                'set -eu',
                `mkdir -p ${shellQuote(ctx.mountPath)}`,
                `mkdir -p "$HOME/.gemini"`,
                `printf 'MF_HOME=%s\\n' "$HOME"`
            ].join('\n')
        ])
        const homeDir = extractHomeDir(setup.stdout)
        await this.skills.materializeForSprite({
            agentId: ctx.agentId,
            runtimeId: ctx.runtimeId,
            userId: ctx.userId,
            framework: 'gemini-cli',
            spriteName: ctx.spriteName,
            client: ctx.client,
            logger: ctx.logger,
            homeDir,
            workspacePath: ctx.mountPath,
            timeoutMs: ctx.execTimeoutMs
        })
        await this.agentContext.write({
            agentId: ctx.agentId,
            framework: 'gemini-cli',
            workspacePath: ctx.mountPath,
            run: spriteContextDocRunner(ctx.client, ctx.spriteName, ctx.logger),
            targetLabel: ctx.spriteName,
            timeoutMs: ctx.execTimeoutMs
        })

        // Installs the CLI when the sprite image ships none — the conditional
        // `npm config set prefix "$HOME/.local"` this replaces was rejected by the
        // image's nvm and poisoned ~/.npmrc (framework-version-registry.ts).
        const frameworkVersion = await installFrameworkVersion(
            ctx,
            'gemini-cli'
        )

        const verify = await execSprite(
            ctx.client,
            ctx.spriteName,
            {
                cmd: [
                    'bash',
                    '-lc',
                    'export PATH="$HOME/.local/bin:$PATH"; gemini --version'
                ],
                // The version probe needs no credentials; a runtime-local
                // create has none to offer.
                env:
                    ctx.modelConfigSource === 'runtime-local'
                        ? undefined
                        : envFor(creds),
                stdin: '',
                timeoutMs: ctx.execTimeoutMs ?? 30_000
            },
            ctx.logger
        )
        if (verify.exitCode !== 0)
            throw new BootstrapError(
                'gemini-verify',
                `gemini --version exited ${verify.exitCode}: ${verify.stderr.slice(0, 512)}`
            )
        return { homeDir, frameworkVersion }
    }
}

const envFor = (
    creds: ResolvedGeminiCliCredentials
): Record<string, string> => {
    const env: Record<string, string> = {
        GEMINI_API_KEY: creds.googleApiKey,
        GOOGLE_GEMINI_BASE_URL:
            creds.googleGeminiBaseUrl?.trim() ||
            OFFICIAL_PROVIDER_BASE_URL.google
    }
    if (creds.model) env.GEMINI_MODEL = creds.model
    return env
}

const execCapturing = async (
    ctx: BootstrapContext,
    step: string,
    cmd: string[]
): Promise<{ stdout: string; stderr: string }> => {
    const result = await execSprite(
        ctx.client,
        ctx.spriteName,
        { cmd, stdin: '', timeoutMs: ctx.execTimeoutMs ?? 60_000 },
        ctx.logger
    )
    if (result.exitCode !== 0)
        throw new BootstrapError(
            step,
            `${step} exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
        )
    return { stdout: result.stdout, stderr: result.stderr }
}
