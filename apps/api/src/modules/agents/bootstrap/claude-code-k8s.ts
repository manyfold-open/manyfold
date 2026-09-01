import {
    K8S_HOME_BASE,
    claudeCliModel,
    claudeModelMapEnv,
    codingAgentHomeRootForWorkspacePath,
    codingAgentWorkspacePath
} from '@manyfold/shared'
import { Injectable } from '@nestjs/common'
import type { ResolvedClaudeCodeCredentials } from '@/modules/agents/credentials/resolved-credentials'
import { resolveAnthropicBaseUrl } from '@/modules/agents/orchestration/bootstrap-invariants'
import { FILES_CONTAINER_PORT } from '@/modules/agents/orchestration/k8s-resource-builder'
import type {
    K8sBootstrapContext,
    K8sBootstrapPlan,
    K8sFrameworkBootstrap,
    K8sPostProvisionContext
} from '@/modules/agents/bootstrap/k8s-framework-bootstrap'
import { SkillMaterializerService } from '@/modules/skills/skill-materializer.service'
import { assertClaudePrintSucceeded } from '@/modules/agents/bootstrap/claude-code-verify'

const DEFAULT_PVC_ROOT = `${K8S_HOME_BASE}/.manyfold`

@Injectable()
export class ClaudeCodeK8sBootstrap implements K8sFrameworkBootstrap {
    readonly framework = 'claude-code' as const

    constructor(private readonly skills: SkillMaterializerService) {}

    plan(ctx: K8sBootstrapContext, credentials: unknown): K8sBootstrapPlan {
        const creds = credentials as ResolvedClaudeCodeCredentials
        const baseUrl = resolveAnthropicBaseUrl({
            source: 'byo',
            byoBaseUrl: creds.anthropicBaseUrl
        })
        const workspacePath =
            ctx.workspacePath ?? codingAgentWorkspacePath('k8s', ctx.agentId)
        const pvcRoot =
            codingAgentHomeRootForWorkspacePath(workspacePath) ??
            DEFAULT_PVC_ROOT
        const mc =
            ctx.modelConfig?.framework === 'claude-code'
                ? ctx.modelConfig
                : null
        return {
            framework: 'claude-code',
            port: null,
            pvcMountPath: pvcRoot,
            workspacePath,
            envSecretData: {
                // Pod env outranks the on-disk OAuth a runtime-local user
                // signs in with, so in that mode the provider keys must not
                // exist in the Secret at all.
                ...(ctx.modelConfigSource === 'runtime-local'
                    ? {}
                    : {
                          ANTHROPIC_BASE_URL: baseUrl,
                          ANTHROPIC_AUTH_TOKEN: creds.anthropicAuthToken,
                          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
                      }),
                WORKSPACE_DIR: workspacePath,
                WORKSPACE_PVC_ROOT: pvcRoot,
                AGENT_ID: ctx.agentId,
                MF_AGENT_ID: ctx.agentId,
                ...(ctx.apiBaseUrl ? { MF_API_URL: ctx.apiBaseUrl } : {}),
                ...(ctx.apiBaseUrl && ctx.apiToken
                    ? { MF_API_TOKEN: ctx.apiToken }
                    : {}),
                ...(ctx.deployEnv ? { MF_DEPLOY_ENV: ctx.deployEnv } : {}),
                ...claudeModelMapEnv(mc)
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
            framework: 'claude-code',
            exec: ctx.exec,
            homeDir: K8S_HOME_BASE,
            timeoutMs: 90_000
        })

        const mc =
            ctx.modelConfig?.framework === 'claude-code'
                ? ctx.modelConfig
                : null
        const cliModel = claudeCliModel(mc, null)
        const verify = await ctx.exec.run({
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
            timeoutMs: 90_000
        })
        assertClaudePrintSucceeded(verify, 'claude-k8s-verify')
    }
}
