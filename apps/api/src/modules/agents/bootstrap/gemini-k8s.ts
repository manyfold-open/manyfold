import {
    K8S_HOME_BASE,
    OFFICIAL_PROVIDER_BASE_URL,
    codingAgentHomeRootForWorkspacePath,
    codingAgentWorkspacePath
} from '@manyfold/shared'
import { Injectable } from '@nestjs/common'
import type { ResolvedGeminiCliCredentials } from '@/modules/agents/credentials/resolved-credentials'
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
export class GeminiCliK8sBootstrap implements K8sFrameworkBootstrap {
    readonly framework = 'gemini-cli' as const

    constructor(private readonly skills: SkillMaterializerService) {}

    plan(ctx: K8sBootstrapContext, credentials: unknown): K8sBootstrapPlan {
        const creds = credentials as ResolvedGeminiCliCredentials
        const workspacePath =
            ctx.workspacePath ?? codingAgentWorkspacePath('k8s', ctx.agentId)
        const pvcRoot =
            codingAgentHomeRootForWorkspacePath(workspacePath) ??
            DEFAULT_PVC_ROOT
        const baseUrl =
            creds.googleGeminiBaseUrl?.trim() ||
            OFFICIAL_PROVIDER_BASE_URL.google
        return {
            framework: 'gemini-cli',
            port: null,
            pvcMountPath: pvcRoot,
            workspacePath,
            envSecretData: {
                GEMINI_API_KEY: creds.googleApiKey,
                GOOGLE_GEMINI_BASE_URL: baseUrl,
                ...(creds.model ? { GEMINI_MODEL: creds.model } : {}),
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
            framework: 'gemini-cli',
            exec: ctx.exec,
            homeDir: K8S_HOME_BASE,
            timeoutMs: 90_000
        })

        const verify = await ctx.exec.run({
            cmd: ['gemini', '--version'],
            timeoutMs: 30_000
        })
        if (verify.exitCode !== 0)
            throw new BootstrapError(
                'gemini-k8s-verify',
                `gemini --version exited ${verify.exitCode}: ${verify.stderr.slice(0, 512)}`
            )
    }
}
