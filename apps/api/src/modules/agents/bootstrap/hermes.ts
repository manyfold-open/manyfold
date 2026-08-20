import { K8S_HOME_BASE } from '@manyfold/shared'
import { Injectable } from '@nestjs/common'
import type { ResolvedHermesCredentials } from '@/modules/agents/credentials/resolved-credentials'
import type {
    K8sBootstrapContext,
    K8sBootstrapPlan,
    K8sFrameworkBootstrap,
    K8sPostProvisionContext,
    K8sSidecarSpec
} from '@/modules/agents/bootstrap/k8s-framework-bootstrap'
import {
    buildHermesEnv,
    generateHermesApiServerKey,
    HERMES_DASHBOARD_PORT,
    HERMES_DASHBOARD_SERVICE_PORT,
    HERMES_PORT
} from '@/modules/agents/bootstrap/hermes-shared'
import { SkillMaterializerService } from '@/modules/skills/skill-materializer.service'

const MOUNT = `${K8S_HOME_BASE}/.hermes`

// Inject "-dashboard" before the first dot so the result stays at the same
// DNS depth as the agent host (so it's covered by the same wildcard cert).
// Example: agent-foo.manyfold.ai → agent-foo-dashboard.manyfold.ai
export const dashboardHostFor = (agentHost: string): string => {
    const idx = agentHost.indexOf('.')
    if (idx < 0) return `${agentHost}-dashboard`
    return `${agentHost.slice(0, idx)}-dashboard${agentHost.slice(idx)}`
}

export const hermesDashboardSidecar = (
    image: string,
    agentHost: string,
    authUrl: string | null,
    authSignin: string | null = null
): K8sSidecarSpec => ({
    name: 'hermes-dashboard',
    image,
    command: ['hermes'],
    args: [
        'dashboard',
        '--host',
        '0.0.0.0',
        '--port',
        String(HERMES_DASHBOARD_PORT),
        '--insecure'
    ],
    envFromMainSecret: true,
    containerPort: HERMES_DASHBOARD_PORT,
    servicePortName: 'dashboard',
    servicePort: HERMES_DASHBOARD_SERVICE_PORT,
    ingressHost: dashboardHostFor(agentHost),
    ingressPath: '/',
    ingressPathType: 'Prefix',
    authUrlAnnotation: authUrl,
    authSigninAnnotation: authSignin,
    resources: {
        requests: { cpu: '50m', memory: '128Mi' },
        limits: { cpu: '300m', memory: '256Mi' }
    },
    mountPvc: true
})

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
