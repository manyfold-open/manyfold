import {
    K8S_HOME_BASE,
    OFFICIAL_PROVIDER_BASE_URL,
    codingAgentHomeRootForWorkspacePath,
    codingAgentWorkspacePath
} from '@manyfold/shared'
import { Injectable } from '@nestjs/common'
import type { ResolvedCodexCredentials } from '@/modules/agents/credentials/resolved-credentials'
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
export class CodexK8sBootstrap implements K8sFrameworkBootstrap {
    readonly framework = 'codex' as const

    constructor(private readonly skills: SkillMaterializerService) {}

    plan(ctx: K8sBootstrapContext, credentials: unknown): K8sBootstrapPlan {
        const creds = credentials as ResolvedCodexCredentials
        const baseUrl =
            creds.openaiBaseUrl?.trim() || OFFICIAL_PROVIDER_BASE_URL.openai
        // Codex supports only the Responses wire API; Chat Completions is
        // deprecated upstream and the entrypoint never honoured the old
        // CODEX_WIRE_API env, so fail loud instead of provisioning a runtime
        // that cannot talk to its provider.
        if (creds.inferenceProtocol === 'openai_chat_completions')
            throw new BootstrapError(
                'codex-k8s-plan',
                'Codex only supports the Responses API; the provider protocol openai_chat_completions cannot work'
            )
        const modelConfig =
            ctx.modelConfig?.framework === 'codex' ? ctx.modelConfig : null
        const model = modelConfig?.model?.trim() || null
        const workspacePath =
            ctx.workspacePath ?? codingAgentWorkspacePath('k8s', ctx.agentId)
        const pvcRoot =
            codingAgentHomeRootForWorkspacePath(workspacePath) ??
            DEFAULT_PVC_ROOT
        return {
            framework: 'codex',
            port: null,
            pvcMountPath: pvcRoot,
            workspacePath,
            envSecretData: {
                OPENAI_API_KEY: creds.openaiApiKey,
                CODEX_BASE_URL: baseUrl,
                ...(model ? { CODEX_MODEL: model } : {}),
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
            framework: 'codex',
            exec: ctx.exec,
            homeDir: K8S_HOME_BASE,
            timeoutMs: 90_000
        })

        const login = await ctx.exec.run({
            cmd: [
                'bash',
                '-lc',
                'printenv OPENAI_API_KEY | codex login --with-api-key'
            ],
            timeoutMs: 60_000
        })
        if (login.exitCode !== 0)
            throw new BootstrapError(
                'codex-k8s-login',
                `codex login exited ${login.exitCode}: ${login.stderr.slice(0, 512)}`
            )

        const verify = await ctx.exec.run({
            cmd: ['codex', '--version'],
            timeoutMs: 30_000
        })
        if (verify.exitCode !== 0)
            throw new BootstrapError(
                'codex-k8s-verify',
                `codex --version exited ${verify.exitCode}: ${verify.stderr.slice(0, 512)}`
            )
    }
}
