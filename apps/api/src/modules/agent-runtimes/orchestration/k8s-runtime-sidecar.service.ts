import { auditAction } from '@manyfold/shared'
import type { AgentRuntimeSummary } from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    BadRequestException,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PatchStrategy, setHeaderOptions } from '@kubernetes/client-node'
import { auditLogs, type AgentRuntimeRow, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { BearerAuthService } from '@/modules/auth/bearer-auth.service'
import {
    KubernetesService,
    isApiNotFound
} from '@/modules/k8s/kubernetes.service'
import {
    hermesDashboardSidecar,
    dashboardHostFor
} from '@/modules/agents/bootstrap/hermes'
import {
    buildSidecarIngress,
    resourceName,
    sidecarIngressName,
    type K8sResourceSpec
} from '@/modules/agents/orchestration/k8s-resource-builder'
import { configString } from '@/common/config-alias'

const IMAGE_CONFIG_KEY = {
    openclaw: 'K8S_IMAGE_OPENCLAW',
    hermes: 'K8S_IMAGE_HERMES'
} as const

type SidecarFramework = keyof typeof IMAGE_CONFIG_KEY

@Injectable()
export class K8sRuntimeSidecarService {
    private readonly log = new Logger(K8sRuntimeSidecarService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly k8s: KubernetesService,
        private readonly config: ConfigService,
        private readonly bearerAuth: BearerAuthService,
        private readonly runtimes: AgentRuntimesService
    ) {}

    async setControlUi(
        callerUserId: string,
        runtimeId: string,
        enabled: boolean,
        isAdmin: boolean
    ): Promise<AgentRuntimeSummary> {
        const runtime = await this.loadRuntime(runtimeId, callerUserId, isAdmin)
        if (runtime.framework !== 'openclaw')
            throw new BadRequestException(
                'control UI toggle only supported for openclaw runtimes'
            )
        this.requireK8s(runtime)
        if (runtime.controlUiEnabled === enabled)
            return this.runtimes.toSummary(runtime)

        const primaryAgentId = this.requirePrimaryAgentId(runtime)
        const name = resourceName(primaryAgentId)
        const envSecretName = `${name}-env`
        const restartedAt = new Date().toISOString()
        const client = await this.k8s.getClient(runtime.clusterId)
        const apis = client.apis

        try {
            await apis.core.patchNamespacedSecret(
                {
                    name: envSecretName,
                    namespace: runtime.namespace!,
                    body: {
                        stringData: {
                            OPENCLAW_CONTROL_UI_ENABLED: enabled
                                ? 'true'
                                : 'false'
                        }
                    }
                },
                setHeaderOptions(
                    'Content-Type',
                    PatchStrategy.StrategicMergePatch
                )
            )
            await apis.apps.patchNamespacedDeployment(
                {
                    name,
                    namespace: runtime.namespace!,
                    body: {
                        spec: {
                            template: {
                                metadata: {
                                    annotations: {
                                        'nca.netmind.ai/restartedAt':
                                            restartedAt
                                    }
                                }
                            }
                        }
                    }
                },
                setHeaderOptions(
                    'Content-Type',
                    PatchStrategy.StrategicMergePatch
                )
            )
        } catch (err) {
            const reason = sanitizeReason(err)
            await this.audit(
                callerUserId,
                auditAction.AGENT_RUNTIME_CONTROL_UI_TOGGLE_FAILED,
                runtime.id,
                {
                    enabled,
                    reason,
                    runtimeId: runtime.id,
                    primaryAgentId,
                    ownerUserId: runtime.userId,
                    onBehalfOf: callerUserId !== runtime.userId
                }
            )
            throw new InternalServerErrorException({
                message: 'failed to toggle openclaw control UI',
                reason
            })
        }

        await this.runtimes.applyStatusPatch(runtime.id, {
            controlUiEnabled: enabled
        })
        await this.audit(
            callerUserId,
            auditAction.AGENT_RUNTIME_CONTROL_UI_TOGGLED,
            runtime.id,
            {
                enabled,
                runtimeId: runtime.id,
                primaryAgentId,
                ownerUserId: runtime.userId,
                onBehalfOf: callerUserId !== runtime.userId
            }
        )
        const refreshed = await this.runtimes.findById(runtime.id)
        if (!refreshed)
            throw new InternalServerErrorException(
                `runtime ${runtime.id} vanished during control UI toggle`
            )
        return this.runtimes.toSummary(refreshed)
    }

    async setDashboard(
        callerUserId: string,
        runtimeId: string,
        enabled: boolean,
        isAdmin: boolean
    ): Promise<AgentRuntimeSummary> {
        const runtime = await this.loadRuntime(runtimeId, callerUserId, isAdmin)
        if (runtime.framework !== 'hermes')
            throw new BadRequestException(
                'dashboard toggle only supported for hermes runtimes'
            )
        this.requireK8s(runtime)
        if (!runtime.ingressHost)
            throw new InternalServerErrorException(
                'hermes runtime missing ingress host'
            )
        if (runtime.dashboardEnabled === enabled)
            return this.runtimes.toSummary(runtime)

        const primaryAgentId = this.requirePrimaryAgentId(runtime)
        const authUrl = enabled
            ? this.requireDashboardAuthUrl(runtime.id)
            : null
        const authSignin = enabled ? this.dashboardSigninUrl() : null
        const image = this.imageForFramework('hermes')
        const sidecar = hermesDashboardSidecar(
            image,
            runtime.ingressHost,
            authUrl,
            authSignin
        )

        const client = await this.k8s.getClient(runtime.clusterId)
        const apis = client.apis
        const name = resourceName(primaryAgentId)
        const envSecretName = `${name}-env`

        try {
            await apis.core.patchNamespacedSecret(
                {
                    name: envSecretName,
                    namespace: runtime.namespace!,
                    body: {
                        stringData: {
                            HERMES_DASHBOARD_ENABLED: enabled ? 'true' : 'false'
                        }
                    }
                },
                setHeaderOptions(
                    'Content-Type',
                    PatchStrategy.StrategicMergePatch
                )
            )

            const dep = await apis.apps.readNamespacedDeployment({
                name,
                namespace: runtime.namespace!
            })
            const podSpec = dep.spec?.template?.spec
            if (!podSpec?.containers)
                throw new Error('deployment missing pod spec containers')
            const existingIdx = podSpec.containers.findIndex(
                (c) => c.name === sidecar.name
            )
            if (enabled && existingIdx < 0) {
                podSpec.containers.push({
                    name: sidecar.name,
                    image: sidecar.image,
                    imagePullPolicy: 'IfNotPresent',
                    command: sidecar.command,
                    args: sidecar.args,
                    envFrom: sidecar.envFromMainSecret
                        ? [{ secretRef: { name: envSecretName } }]
                        : undefined,
                    ports: [
                        {
                            containerPort: sidecar.containerPort,
                            name: sidecar.servicePortName
                        }
                    ],
                    resources: sidecar.resources,
                    volumeMounts: sidecar.mountPvc
                        ? [{ name: 'data', mountPath: runtime.mountPath }]
                        : undefined
                })
            } else if (!enabled && existingIdx >= 0) {
                podSpec.containers.splice(existingIdx, 1)
            }
            if (!dep.spec!.template!.metadata) dep.spec!.template!.metadata = {}
            dep.spec!.template!.metadata.annotations = {
                ...(dep.spec!.template!.metadata.annotations ?? {}),
                'nca.netmind.ai/restartedAt': new Date().toISOString()
            }
            await apis.apps.replaceNamespacedDeployment({
                name,
                namespace: runtime.namespace!,
                body: dep
            })

            const svc = await apis.core.readNamespacedService({
                name,
                namespace: runtime.namespace!
            })
            const ports = svc.spec?.ports
            if (!ports) throw new Error('service missing ports')
            const portIdx = ports.findIndex(
                (p) => p.name === sidecar.servicePortName
            )
            if (enabled && portIdx < 0) {
                ports.push({
                    name: sidecar.servicePortName,
                    port: sidecar.servicePort,
                    targetPort: sidecar.containerPort,
                    protocol: 'TCP'
                })
            } else if (!enabled && portIdx >= 0) {
                ports.splice(portIdx, 1)
            }
            await apis.core.replaceNamespacedService({
                name,
                namespace: runtime.namespace!,
                body: svc
            })

            const ingName = sidecarIngressName(primaryAgentId, sidecar.name)
            if (enabled) {
                const ingressSpec: K8sResourceSpec = {
                    agentId: primaryAgentId,
                    userId: runtime.userId,
                    namespace: runtime.namespace!,
                    framework: 'hermes',
                    image,
                    port: null,
                    host: runtime.ingressHost,
                    storageClass: '',
                    pvcMountPath: runtime.mountPath,
                    envSecretName,
                    envSecretKeys: []
                }
                try {
                    await apis.networking.readNamespacedIngress({
                        name: ingName,
                        namespace: runtime.namespace!
                    })
                } catch (err) {
                    if (isApiNotFound(err))
                        await apis.networking.createNamespacedIngress({
                            namespace: runtime.namespace!,
                            body: buildSidecarIngress(ingressSpec, sidecar)
                        })
                    else throw err
                }
            } else {
                try {
                    await apis.networking.deleteNamespacedIngress({
                        name: ingName,
                        namespace: runtime.namespace!
                    })
                } catch (err) {
                    if (!isApiNotFound(err)) throw err
                }
            }
        } catch (err) {
            const reason = sanitizeReason(err)
            await this.audit(
                callerUserId,
                auditAction.AGENT_RUNTIME_DASHBOARD_TOGGLE_FAILED,
                runtime.id,
                {
                    enabled,
                    reason,
                    runtimeId: runtime.id,
                    primaryAgentId,
                    ownerUserId: runtime.userId,
                    onBehalfOf: callerUserId !== runtime.userId
                }
            )
            throw new InternalServerErrorException({
                message: 'failed to toggle hermes dashboard',
                reason
            })
        }

        await this.runtimes.applyStatusPatch(runtime.id, {
            dashboardEnabled: enabled
        })
        await this.audit(
            callerUserId,
            auditAction.AGENT_RUNTIME_DASHBOARD_TOGGLED,
            runtime.id,
            {
                enabled,
                runtimeId: runtime.id,
                primaryAgentId,
                ownerUserId: runtime.userId,
                onBehalfOf: callerUserId !== runtime.userId
            }
        )
        const refreshed = await this.runtimes.findById(runtime.id)
        if (!refreshed)
            throw new InternalServerErrorException(
                `runtime ${runtime.id} vanished during dashboard toggle`
            )
        return this.runtimes.toSummary(refreshed)
    }

    async checkDashboardAuth(
        cookieHeader: string,
        runtimeId: string
    ): Promise<boolean> {
        // Try the apex-scoped dashboard cookie first (set by /dashboard-ticket),
        // then fall back to the legacy cookie name.
        const mfMatch = cookieHeader.match(/(?:^|;\s*)mf_dashboard=([^;]+)/)
        const legacyMatch = cookieHeader.match(
            /(?:^|;\s*)nca_dashboard=([^;]+)/
        )
        const candidates: string[] = []
        if (mfMatch) candidates.push(decodeURIComponent(mfMatch[1]))
        if (legacyMatch) candidates.push(decodeURIComponent(legacyMatch[1]))
        if (candidates.length === 0) return false
        const runtime = await this.runtimes.findById(runtimeId)
        if (!runtime) return false
        if (runtime.framework !== 'hermes' || !runtime.dashboardEnabled)
            return false
        for (const token of candidates) {
            try {
                const auth = await this.bearerAuth.verifyBearerToken(token)
                if (auth.userId === runtime.userId) return true
            } catch {
                /* try next candidate */
            }
        }
        return false
    }

    // Validate that a dashboard URL points at a Hermes runtime the user
    // owns. Used by the dashboard-ticket endpoint to refuse minting an
    // apex cookie for someone else's runtime.
    async resolveOwnedDashboardRuntime(
        dashboardUrl: string,
        userId: string
    ): Promise<AgentRuntimeRow | null> {
        let url: URL
        try {
            url = new URL(dashboardUrl)
        } catch {
            return null
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
        const dashHost = url.hostname
        // dashboardHostFor() injects "-dashboard" before the first dot of
        // the agent host. Reverse: strip the first "-dashboard." occurrence.
        const m = dashHost.match(/^(.+?)-dashboard(\..+)$/)
        if (!m) return null
        const agentHost = `${m[1]}${m[2]}`
        const runtime = await this.runtimes.findByIngressHost(agentHost)
        if (!runtime) return null
        if (runtime.userId !== userId) return null
        if (runtime.framework !== 'hermes' || !runtime.dashboardEnabled)
            return null
        return runtime
    }

    dashboardHost(ingressHost: string): string {
        return dashboardHostFor(ingressHost)
    }

    private async loadRuntime(
        runtimeId: string,
        callerUserId: string,
        isAdmin: boolean
    ): Promise<AgentRuntimeRow> {
        const row = await this.runtimes.findById(runtimeId)
        if (!row || (!isAdmin && row.userId !== callerUserId))
            throw new NotFoundException(`agent runtime ${runtimeId} not found`)
        return row
    }

    private requireK8s(runtime: AgentRuntimeRow): void {
        if (runtime.kind !== 'k8s' || !runtime.namespace)
            throw new InternalServerErrorException(
                `runtime ${runtime.id} is not a k8s runtime with a namespace`
            )
    }

    private requirePrimaryAgentId(runtime: AgentRuntimeRow): string {
        if (!runtime.primaryAgentId)
            throw new InternalServerErrorException(
                `runtime ${runtime.id} has no primaryAgentId; cannot compute k8s resource name`
            )
        return runtime.primaryAgentId
    }

    private requireDashboardAuthUrl(runtimeId: string): string {
        const base = configString(this.config, ['MF_AUTH_URL', 'NCA_AUTH_URL'])
        if (!base)
            throw new InternalServerErrorException(
                `MF_AUTH_URL not set; refusing to enable dashboard ingress for runtime ${runtimeId}`
            )
        return `${base.replace(/\/+$/, '')}/agent-runtimes/${runtimeId}/dashboard-auth-check`
    }

    // When the auth-url subrequest returns 401, nginx-ingress redirects the
    // browser here so the user can sign in and bounce back to the dashboard
    // (the apex-scoped mf_dashboard cookie is then issued by /dashboard-ticket
    // and flows to the subdomain on the next attempt). Without this annotation,
    // unauthenticated users see an opaque nginx 401 page.
    private dashboardSigninUrl(): string | null {
        const base =
            configString(this.config, [
                'MF_DASHBOARD_SIGNIN_URL',
                'NCA_DASHBOARD_SIGNIN_URL'
            ]) ?? ''
        if (!base) return null
        const sep = base.includes('?') ? '&' : '?'
        return `${base}${sep}redirect_url=$escaped_request_uri`
    }

    private imageForFramework(framework: SidecarFramework): string {
        const key = IMAGE_CONFIG_KEY[framework]
        const image = this.config.get<string>(key)
        if (!image) throw new InternalServerErrorException(`${key} not set`)
        return image
    }

    private async audit(
        actorId: string,
        action: string,
        subject: string,
        meta: Record<string, unknown>
    ): Promise<void> {
        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId,
                action,
                subject,
                meta
            })
        } catch (err) {
            this.log.warn(
                `audit write failed: ${(err as Error).message} action=${action}`
            )
        }
    }
}

const sanitizeReason = (err: unknown): string => {
    const msg = (err as Error)?.message ?? 'unknown error'
    return msg.slice(0, 512).replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]')
}
