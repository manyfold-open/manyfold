import { K8S_HOME_BASE } from '@manyfold/shared'
import { Injectable } from '@nestjs/common'
import type { ResolvedHermesCredentials } from '@/modules/agents/credentials/resolved-credentials'
import type {
    K8sBootstrapContext,
    K8sBootstrapPlan,
    K8sFrameworkBootstrap,
    K8sPostProvisionContext
} from '@/modules/agents/bootstrap/k8s-framework-bootstrap'
import {
    buildHermesEnv,
    generateHermesApiServerKey,
    HERMES_PORT
} from '@/modules/agents/bootstrap/hermes-shared'
import { SkillMaterializerService } from '@/modules/skills/skill-materializer.service'

const MOUNT = `${K8S_HOME_BASE}/.hermes`

@Injectable()
export class HermesBootstrap implements K8sFrameworkBootstrap {
    readonly framework = 'hermes' as const

    constructor(private readonly skills: SkillMaterializerService) {}

    plan(ctx: K8sBootstrapContext, credentials: unknown): K8sBootstrapPlan {
        const creds = credentials as ResolvedHermesCredentials
        const apiServerKey = generateHermesApiServerKey(creds.apiServerKey)
        const env = buildHermesEnv({
            creds,
            apiServerKey,
            dashboardEnabled: ctx.dashboardEnabled
        })

        return {
            framework: 'hermes',
            port: HERMES_PORT,
            pvcMountPath: MOUNT,
            envSecretData: env,
            readinessProbe: {
                httpGet: { path: '/v1/health', port: HERMES_PORT },
                initialDelaySeconds: 15,
                periodSeconds: 10,
                failureThreshold: 30
            },
            httpReadinessPath: '/v1/health',
            generatedCredentials: { apiServerKey }
        }
    }

    async postProvision(ctx: K8sPostProvisionContext): Promise<void> {
        await this.skills.materializeK8sRuntimeAgents({
            runtimeId: ctx.runtimeId,
            userId: ctx.userId,
            framework: 'hermes',
            exec: ctx.exec,
            homeDir: MOUNT,
            timeoutMs: 90_000
        })
    }
}
