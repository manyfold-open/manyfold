import { AGY_MANAGED_HOST_ENV } from '@manyfold/shared'
import { execSprite } from '@manyfold/sprites'
import { Injectable } from '@nestjs/common'
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

// No login step and nothing credential-shaped on the sprite: a platform key
// rides every chat exec as env and agy's API-key mode is switched on in the
// platform view each exec builds (antigravity-app-dir.ts), while the host's
// own sign-in, if the user makes one in the terminal, stays agy's to keep.
// What the sprite keeps is the pinned binary and agy's own app data.
@Injectable()
export class AntigravityCliBootstrap implements FrameworkBootstrap {
    readonly framework = 'antigravity-cli' as const

    constructor(
        private readonly skills: SkillMaterializerService,
        private readonly agentContext: AgentContextDocService
    ) {}

    async run(ctx: BootstrapContext): Promise<BootstrapResult> {
        const setup = await execCapturing(ctx, 'antigravity-setup-dirs', [
            'bash',
            '-lc',
            [
                `mkdir -p ${shellQuote(ctx.mountPath)}`,
                `printf 'MF_HOME=%s\\n' "$HOME"`
            ].join('\n')
        ])
        const homeDir = extractHomeDir(setup.stdout)
        await this.skills.materializeForSprite({
            agentId: ctx.agentId,
            runtimeId: ctx.runtimeId,
            userId: ctx.userId,
            framework: 'antigravity-cli',
            spriteName: ctx.spriteName,
            client: ctx.client,
            logger: ctx.logger,
            homeDir,
            workspacePath: ctx.mountPath,
            timeoutMs: ctx.execTimeoutMs
        })
        await this.agentContext.write({
            agentId: ctx.agentId,
            framework: 'antigravity-cli',
            workspacePath: ctx.mountPath,
            run: spriteContextDocRunner(ctx.client, ctx.spriteName, ctx.logger),
            targetLabel: ctx.spriteName,
            timeoutMs: ctx.execTimeoutMs
        })

        const frameworkVersion = await installFrameworkVersion(
            ctx,
            'antigravity-cli'
        )

        const verify = await execSprite(
            ctx.client,
            ctx.spriteName,
            {
                cmd: ['agy', '--version'],
                env: { ...AGY_MANAGED_HOST_ENV },
                stdin: '',
                timeoutMs: ctx.execTimeoutMs ?? 30_000
            },
            ctx.logger
        )
        if (verify.exitCode !== 0)
            throw new BootstrapError(
                'antigravity-verify',
                `agy --version exited ${verify.exitCode}: ${verify.stderr.slice(0, 512)}`
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
