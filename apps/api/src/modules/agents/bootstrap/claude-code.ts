import {
    claudeCliModel,
    claudeModelMapEnv
} from '@manyfold/shared'
import { execSprite } from '@manyfold/sprites'
import { Injectable } from '@nestjs/common'
import { assertClaudePrintSucceeded } from '@/modules/agents/bootstrap/claude-code-verify'
import { resolveAnthropicBaseUrl } from '@/modules/agents/orchestration/bootstrap-invariants'
import {
    BootstrapError,
    type BootstrapContext,
    type BootstrapResult,
    type FrameworkBootstrap
} from '@/modules/agents/bootstrap/framework-bootstrap'
import { extractHomeDir } from '@/modules/agents/bootstrap/home-probe'
import { installFrameworkVersion } from '@/modules/agents/bootstrap/framework-version-install'
import type { ResolvedClaudeCodeCredentials } from '@/modules/agents/credentials/resolved-credentials'
import { SkillMaterializerService } from '@/modules/skills/skill-materializer.service'
import {
    AgentContextDocService,
    spriteContextDocRunner
} from '@/modules/agent-self/agent-context-doc.service'
import { shellQuote } from '@/modules/agents/workspace/workspace-preflight'

@Injectable()
export class ClaudeCodeBootstrap implements FrameworkBootstrap {
    readonly framework = 'claude-code' as const

    constructor(
        private readonly skills: SkillMaterializerService,
        private readonly agentContext: AgentContextDocService
    ) {}

    async run(
        ctx: BootstrapContext,
        credentials: unknown
    ): Promise<BootstrapResult> {
        const creds = credentials as ResolvedClaudeCodeCredentials
        const baseUrl = resolveAnthropicBaseUrl({
            source: 'byo',
            byoBaseUrl: creds.anthropicBaseUrl
        })
        const setup = await execCapturing(ctx, 'mkdir-workspace', [
            'bash',
            '-lc',
            [
                'set -eu',
                `mkdir -p ${shellQuote(ctx.mountPath)}`,
                `mkdir -p "$HOME/.claude"`,
                `printf 'MF_HOME=%s\\n' "$HOME"`
            ].join(' && ')
        ])
        const homeDir = extractHomeDir(setup.stdout)
        await this.skills.materializeForSprite({
            agentId: ctx.agentId,
            runtimeId: ctx.runtimeId,
            userId: ctx.userId,
            framework: 'claude-code',
            spriteName: ctx.spriteName,
            client: ctx.client,
            logger: ctx.logger,
            homeDir,
            workspacePath: ctx.mountPath,
            timeoutMs: ctx.execTimeoutMs
        })
        await this.agentContext.write({
            agentId: ctx.agentId,
            framework: 'claude-code',
            workspacePath: ctx.mountPath,
            run: spriteContextDocRunner(ctx.client, ctx.spriteName, ctx.logger),
            targetLabel: ctx.spriteName,
            timeoutMs: ctx.execTimeoutMs
        })

        const frameworkVersion = await installFrameworkVersion(
            ctx,
            'claude-code'
        )

        const mc =
            ctx.modelConfig?.framework === 'claude-code'
                ? ctx.modelConfig
                : null
        const cliModel = claudeCliModel(mc, null)
        const modelEnv = claudeModelMapEnv(mc)
        let verify: Awaited<ReturnType<typeof execSprite>>
        try {
            verify = await execSprite(
                ctx.client,
                ctx.spriteName,
                {
                    cmd: [
                        'claude',
                        '--print',
                        ...(cliModel ? ['--model', cliModel] : []),
                        '--output-format',
                        'json',
                        '--max-turns',
                        '1',
                        '--max-budget-usd',
                        '0.50',
                        '--no-session-persistence',
                        'Reply with exactly: pong'
                    ],
                    env: {
                        ANTHROPIC_BASE_URL: baseUrl,
                        ANTHROPIC_AUTH_TOKEN: creds.anthropicAuthToken,
                        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
                        ...modelEnv
                    },
                    stdin: '',
                    timeoutMs: claudeVerifyTimeoutMs(ctx.execTimeoutMs)
                },
                ctx.logger
            )
        } catch (err) {
            throw new BootstrapError(
                'claude-verify',
                `claude --print failed: ${(err as Error).message}`,
                err
            )
        }
        assertClaudePrintSucceeded(verify, 'claude-verify')
        return { homeDir, frameworkVersion }
    }
}

export const CLAUDE_VERIFY_TIMEOUT_MS = 180_000

export const claudeVerifyTimeoutMs = (baseTimeoutMs?: number): number =>
    Math.max(baseTimeoutMs ?? 0, CLAUDE_VERIFY_TIMEOUT_MS)

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
