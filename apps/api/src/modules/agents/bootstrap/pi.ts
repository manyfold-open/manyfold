import { execSprite } from '@manyfold/sprites'
import { Injectable } from '@nestjs/common'
import { piAgentDirSetupScript } from '@/modules/agents/credentials/pi-agent-dir'
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

// No login step: the vendor key rides every chat exec as env (pi.adapter.ts)
// and never lands on disk, and the endpoint lives in the platform view each
// exec builds (pi-agent-dir.ts). What the sprite keeps in ~/.pi/agent is its
// settings and pi's own session files.
@Injectable()
export class PiBootstrap implements FrameworkBootstrap {
    readonly framework = 'pi' as const

    constructor(
        private readonly skills: SkillMaterializerService,
        private readonly agentContext: AgentContextDocService
    ) {}

    async run(ctx: BootstrapContext): Promise<BootstrapResult> {
        const setup = await execCapturing(ctx, 'pi-setup-dirs', [
            'bash',
            '-lc',
            [
                piAgentDirSetupScript(),
                `mkdir -p ${shellQuote(ctx.mountPath)}`,
                `printf 'MF_HOME=%s\\n' "$HOME"`
            ].join('\n')
        ])
        const homeDir = extractHomeDir(setup.stdout)
        await this.skills.materializeForSprite({
            agentId: ctx.agentId,
            runtimeId: ctx.runtimeId,
            userId: ctx.userId,
            framework: 'pi',
            spriteName: ctx.spriteName,
            client: ctx.client,
            logger: ctx.logger,
            homeDir,
            workspacePath: ctx.mountPath,
            timeoutMs: ctx.execTimeoutMs
        })
        await this.agentContext.write({
            agentId: ctx.agentId,
            framework: 'pi',
            workspacePath: ctx.mountPath,
            run: spriteContextDocRunner(ctx.client, ctx.spriteName, ctx.logger),
            targetLabel: ctx.spriteName,
            timeoutMs: ctx.execTimeoutMs
        })

        const frameworkVersion = await installFrameworkVersion(ctx, 'pi')

        const verify = await execSprite(
            ctx.client,
            ctx.spriteName,
            {
                cmd: ['pi', '--version'],
                env: { PI_OFFLINE: '1' },
                stdin: '',
                timeoutMs: ctx.execTimeoutMs ?? 30_000
            },
            ctx.logger
        )
        if (verify.exitCode !== 0)
            throw new BootstrapError(
                'pi-verify',
                `pi --version exited ${verify.exitCode}: ${verify.stderr.slice(0, 512)}`
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
