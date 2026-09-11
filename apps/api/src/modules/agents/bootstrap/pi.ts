import { execSprite } from '@manyfold/sprites'
import { Injectable } from '@nestjs/common'
import type { ResolvedPiCredentials } from '@/modules/agents/credentials/resolved-credentials'
import { piAgentDirReconcileScript } from '@/modules/agents/credentials/pi-models-json'
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
// and never lands on disk. What the sprite keeps is ~/.pi/agent — settings,
// the optional models.json base-URL override, and pi's own session files.
@Injectable()
export class PiBootstrap implements FrameworkBootstrap {
    readonly framework = 'pi' as const

    constructor(
        private readonly skills: SkillMaterializerService,
        private readonly agentContext: AgentContextDocService
    ) {}

    async run(
        ctx: BootstrapContext,
        credentials: unknown
    ): Promise<BootstrapResult> {
        const creds = credentials as ResolvedPiCredentials
        const setup = await execCapturing(ctx, 'pi-setup-dirs', [
            'bash',
            '-lc',
            [
                piAgentDirReconcileScript(creds.provider, creds.baseUrl),
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
