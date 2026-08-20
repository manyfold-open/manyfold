import { randomBytes } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import type {
    K8sBootstrapContext,
    K8sBootstrapPlan,
    K8sFrameworkBootstrap
} from '@/modules/agents/bootstrap/k8s-framework-bootstrap'

export const NARRANEXUS_PORT = 8000
const PVC_MOUNT = '/data'

export interface NarraNexusCredentialsInput {
    gatewayToken?: string
    claudeCodeOauthToken?: string
    // Persisted by the sprite bootstrap (generatedCredentials); doubles as
    // the notify-webhook bearer. The k8s path never injects the managed
    // trigger env: a k8s pod runs 24/7 without suspend, so NarraNexus's
    // internal job/channel triggers remain the correct owners there.
    runtimeReportToken?: string
}

export const generateNarraNexusGatewayToken = (
    existing?: string | null
): string => existing ?? randomBytes(32).toString('hex')

@Injectable()
export class NarraNexusK8sBootstrap implements K8sFrameworkBootstrap {
    readonly framework = 'narranexus' as const

    plan(_ctx: K8sBootstrapContext, credentials: unknown): K8sBootstrapPlan {
        const creds = (credentials ?? {}) as NarraNexusCredentialsInput
        const gatewayToken = generateNarraNexusGatewayToken(creds.gatewayToken)

        const env: Record<string, string> = {
            ENABLE_MANYFOLD_API: '1',
            MANYFOLD_GATEWAY_TOKEN: gatewayToken
        }
        if (creds.claudeCodeOauthToken)
            env.CLAUDE_CODE_OAUTH_TOKEN = creds.claudeCodeOauthToken

        return {
            framework: 'narranexus',
            port: NARRANEXUS_PORT,
            pvcMountPath: PVC_MOUNT,
            envSecretData: env,
            readinessProbe: {
                httpGet: { path: '/healthz', port: NARRANEXUS_PORT },
                initialDelaySeconds: 30,
                periodSeconds: 10,
                failureThreshold: 60
            },
            httpReadinessPath: '/healthz',
            generatedCredentials: { gatewayToken },
            resources: {
                requests: { cpu: '500m', memory: '1Gi' },
                limits: { cpu: '2000m', memory: '4Gi' }
            }
        }
    }
}
