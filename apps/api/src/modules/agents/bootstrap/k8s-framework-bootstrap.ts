import type {
    AgentModelConfig,
    AgentModelConfigSource
} from '@manyfold/shared'
import type { Logger } from '@nestjs/common'
import type { V1Probe } from '@kubernetes/client-node'
import type { PodExec } from '@/modules/k8s/pod-exec'

export type K8sFramework =
    | 'openclaw'
    | 'hermes'
    | 'claude-code'
    | 'codex'
    | 'gemini-cli'
    | 'narranexus'

export interface K8sBootstrapContext {
    agentId: string
    runtimeId: string
    userId: string
    namespace: string
    host: string
    image: string
    controlUiEnabled: boolean
    dashboardEnabled: boolean
    workspacePath?: string
    modelConfig?: AgentModelConfig | null
    // 'runtime-local' = the CLI inside the pod owns the model credentials
    // (subscription sign-in): plan() must keep every provider key out of the
    // env Secret — pod env outranks the on-disk OAuth the user signs in with.
    modelConfigSource?: AgentModelConfigSource | null
    apiBaseUrl?: string
    apiToken?: string
    deployEnv?: string
}

export interface K8sSidecarSpec {
    name: string
    image: string
    command?: string[]
    args?: string[]
    envFromMainSecret?: boolean
    containerPort: number
    servicePortName: string
    servicePort: number
    ingressHost?: string
    ingressPath?: string
    ingressPathType?: 'Prefix' | 'Exact' | 'ImplementationSpecific'
    authUrlAnnotation?: string | null
    authSigninAnnotation?: string | null
    resources?: {
        requests?: { cpu?: string; memory?: string }
        limits?: { cpu?: string; memory?: string }
    }
    mountPvc?: boolean
}

export interface K8sBootstrapPlan {
    framework: K8sFramework
    port: number | null
    pvcMountPath: string
    /**
     * Where the agent considers its workspace to be. Defaults to pvcMountPath
     * when omitted. Coding agents (claude-code/codex/gemini-cli) point this at
     * a per-agent subpath of the PVC (e.g. `~/.manyfold/workspaces/<agentId>/`)
     * while their pvcMountPath stays at the PVC root so additional state can
     * coexist under the same volume.
     */
    workspacePath?: string
    envSecretData: Record<string, string>
    readinessProbe: V1Probe | null
    httpReadinessPath: string | null
    generatedCredentials?: Record<string, string>
    resources?: {
        requests?: { cpu?: string; memory?: string }
        limits?: { cpu?: string; memory?: string }
    }
    sidecars?: K8sSidecarSpec[]
}

export interface K8sPostProvisionContext {
    agentId: string
    runtimeId: string
    userId: string
    namespace: string
    podName: string
    containerName: string
    exec: PodExec
    logger: Logger
    modelConfig?: AgentModelConfig | null
    // See K8sBootstrapContext: skips key logins and paid verify turns.
    modelConfigSource?: AgentModelConfigSource | null
}

export interface K8sFrameworkBootstrap {
    readonly framework: K8sFramework
    plan(ctx: K8sBootstrapContext, credentials: unknown): K8sBootstrapPlan
    postProvision?(ctx: K8sPostProvisionContext): Promise<void>
}
