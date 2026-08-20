import { OFFICIAL_PROVIDER_BASE_URL } from '@manyfold/shared'
import { execSprite } from '@manyfold/sprites'
import { Injectable } from '@nestjs/common'
import type { ResolvedCodexCredentials } from '@/modules/agents/credentials/resolved-credentials'
import { buildCodexConfigToml } from '@/modules/agents/credentials/codex-config-toml'
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
export class CodexBootstrap implements FrameworkBootstrap {
    readonly framework = 'codex' as const

    constructor(
        private readonly skills: SkillMaterializerService,
        private readonly agentContext: AgentContextDocService
    ) {}

    async run(
        ctx: BootstrapContext,
        credentials: unknown
    ): Promise<BootstrapResult> {
        const creds = credentials as ResolvedCodexCredentials
        const baseUrl =
            creds.openaiBaseUrl?.trim() || OFFICIAL_PROVIDER_BASE_URL.openai
        const configToml = buildCodexConfigToml(baseUrl)

        const setup = await execCapturing(ctx, 'codex-setup-dirs', [
            'bash',
            '-lc',
            [
                'set -eu',
                `mkdir -p ${shellQuote(ctx.mountPath)}`,
                `mkdir -p "$HOME/.codex"`,
                `cat > "$HOME/.codex/config.toml" <<'MF_CODEX_EOF'\n${configToml}\nMF_CODEX_EOF`,
                `printf 'MF_HOME=%s\\n' "$HOME"`
            ].join('\n')
        ])
        const homeDir = extractHomeDir(setup.stdout)
        await this.skills.materializeForSprite({
            agentId: ctx.agentId,
            runtimeId: ctx.runtimeId,
            userId: ctx.userId,
            framework: 'codex',
            spriteName: ctx.spriteName,
            client: ctx.client,
            logger: ctx.logger,
            homeDir,
            workspacePath: ctx.mountPath,
            timeoutMs: ctx.execTimeoutMs
        })
        await this.agentContext.write({
            agentId: ctx.agentId,
            framework: 'codex',
            workspacePath: ctx.mountPath,
            run: spriteContextDocRunner(ctx.client, ctx.spriteName, ctx.logger),
            targetLabel: ctx.spriteName,
            timeoutMs: ctx.execTimeoutMs
        })

        const frameworkVersion = await installFrameworkVersion(ctx, 'codex')

        const login = await execSprite(
            ctx.client,
            ctx.spriteName,
            {
                cmd: [
                    'bash',
                    '-lc',
                    'printenv OPENAI_API_KEY | codex login --with-api-key'
                ],
                env: { OPENAI_API_KEY: creds.openaiApiKey },
                stdin: '',
                timeoutMs: ctx.execTimeoutMs ?? 60_000
            },
            ctx.logger
        )
        if (login.exitCode !== 0)
            throw new BootstrapError(
                'codex-login',
                `codex login exited ${login.exitCode}: ${login.stderr.slice(0, 512)}`
            )

        const verify = await execSprite(
            ctx.client,
            ctx.spriteName,
            {
                cmd: ['codex', '--version'],
                stdin: '',
                timeoutMs: ctx.execTimeoutMs ?? 30_000
            },
            ctx.logger
        )
        if (verify.exitCode !== 0)
            throw new BootstrapError(
                'codex-verify',
                `codex --version exited ${verify.exitCode}: ${verify.stderr.slice(0, 512)}`
            )
        return { homeDir, frameworkVersion }
    }
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
