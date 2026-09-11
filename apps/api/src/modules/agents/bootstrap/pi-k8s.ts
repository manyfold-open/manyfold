import {
    K8S_HOME_BASE,
    PI_API_KEY_ENV,
    codingAgentHomeRootForWorkspacePath,
    codingAgentWorkspacePath,
    isOfficialPiBaseUrl
} from '@manyfold/shared'
import { Injectable } from '@nestjs/common'
import type { ResolvedPiCredentials } from '@/modules/agents/credentials/resolved-credentials'
import { FILES_CONTAINER_PORT } from '@/modules/agents/orchestration/k8s-resource-builder'
import { BootstrapError } from '@/modules/agents/bootstrap/framework-bootstrap'
import type {
    K8sBootstrapContext,
    K8sBootstrapPlan,
    K8sFrameworkBootstrap,
    K8sPostProvisionContext
} from '@/modules/agents/bootstrap/k8s-framework-bootstrap'
import { SkillMaterializerService } from '@/modules/skills/skill-materializer.service'

const DEFAULT_PVC_ROOT = `${K8S_HOME_BASE}/.manyfold`

@Injectable()
export class PiK8sBootstrap implements K8sFrameworkBootstrap {
    readonly framework = 'pi' as const

    constructor(private readonly skills: SkillMaterializerService) {}

    plan(ctx: K8sBootstrapContext, credentials: unknown): K8sBootstrapPlan {
        const creds = credentials as ResolvedPiCredentials
        const workspacePath =
            ctx.workspacePath ?? codingAgentWorkspacePath('k8s', ctx.agentId)
        const pvcRoot =
            codingAgentHomeRootForWorkspacePath(workspacePath) ??
            DEFAULT_PVC_ROOT
        const baseUrl = creds.baseUrl?.trim()
        return {
            framework: 'pi',
            port: null,
            pvcMountPath: pvcRoot,
            workspacePath,
            envSecretData: {
                [PI_API_KEY_ENV[creds.provider]]: creds.apiKey,
                // The image entrypoint renders ~/.pi/agent/models.json from
                // these on every start (and removes it when PI_BASE_URL is
                // absent), so a credential re-apply is just a pod restart.
                PI_PROVIDER: creds.provider,
                ...(baseUrl && !isOfficialPiBaseUrl(creds.provider, baseUrl)
                    ? { PI_BASE_URL: baseUrl }
                    : {}),
                PI_OFFLINE: '1',
                WORKSPACE_DIR: workspacePath,
                WORKSPACE_PVC_ROOT: pvcRoot,
                AGENT_ID: ctx.agentId,
                MF_AGENT_ID: ctx.agentId,
                ...(ctx.apiBaseUrl ? { MF_API_URL: ctx.apiBaseUrl } : {}),
                ...(ctx.apiBaseUrl && ctx.apiToken
                    ? { MF_API_TOKEN: ctx.apiToken }
                    : {}),
                ...(ctx.deployEnv ? { MF_DEPLOY_ENV: ctx.deployEnv } : {})
            },
            readinessProbe: {
                tcpSocket: { port: FILES_CONTAINER_PORT },
                initialDelaySeconds: 3,
                periodSeconds: 3,
                failureThreshold: 40
            },
            httpReadinessPath: null
        }
    }

    async postProvision(ctx: K8sPostProvisionContext): Promise<void> {
        await this.skills.materializeForK8sPod({
            agentId: ctx.agentId,
            runtimeId: ctx.runtimeId,
            userId: ctx.userId,
            framework: 'pi',
            exec: ctx.exec,
            homeDir: K8S_HOME_BASE,
            timeoutMs: 90_000
        })

        const verify = await ctx.exec.run({
            cmd: ['pi', '--version'],
            timeoutMs: 30_000
        })
        if (verify.exitCode !== 0)
            throw new BootstrapError(
                'pi-k8s-verify',
                `pi --version exited ${verify.exitCode}: ${verify.stderr.slice(0, 512)}`
            )
    }
}
