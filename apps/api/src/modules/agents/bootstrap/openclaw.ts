import { K8S_HOME_BASE } from '@manyfold/shared'
import { Injectable } from '@nestjs/common'
import type { ResolvedOpenclawCredentials } from '@/modules/agents/credentials/resolved-credentials'
import type {
    K8sBootstrapContext,
    K8sBootstrapPlan,
    K8sFrameworkBootstrap
} from '@/modules/agents/bootstrap/k8s-framework-bootstrap'
import {
    buildOpenclawEnv,
    generateOpenclawGatewayToken,
    OPENCLAW_PORT,
    openclawDefaultWorkspace
} from '@/modules/agents/bootstrap/openclaw-shared'

const MOUNT = `${K8S_HOME_BASE}/.openclaw`

export { openclawDefaultWorkspace }

@Injectable()
export class OpenClawBootstrap implements K8sFrameworkBootstrap {
    readonly framework = 'openclaw' as const

    plan(ctx: K8sBootstrapContext, credentials: unknown): K8sBootstrapPlan {
        const creds = credentials as ResolvedOpenclawCredentials
        const gatewayToken = generateOpenclawGatewayToken(creds.gatewayToken)
        const env = buildOpenclawEnv({
            creds,
            gatewayToken,
            workspacePath:
                ctx.workspacePath ?? openclawDefaultWorkspace(MOUNT),
            controlUiEnabled: ctx.controlUiEnabled
        })

        return {
            framework: 'openclaw',
            port: OPENCLAW_PORT,
            pvcMountPath: MOUNT,
            envSecretData: env,
            readinessProbe: {
                httpGet: { path: '/healthz', port: OPENCLAW_PORT },
                initialDelaySeconds: 30,
                periodSeconds: 10,
                failureThreshold: 60
            },
            httpReadinessPath: '/healthz',
            generatedCredentials: { gatewayToken },
            resources: {
                requests: { cpu: '200m', memory: '1Gi' },
                limits: { cpu: '1000m', memory: '2Gi' }
            }
        }
    }
}
