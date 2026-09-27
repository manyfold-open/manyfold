import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { ConfigurationOptions } from '@kubernetes/client-node'
import type {
    K8sProviderRef,
    RuntimeHostPowerState,
    RuntimeHostProviderRef
} from '@manyfold/db'
import {
    isApiConflict,
    KubernetesService,
    type K8sClient
} from '@/modules/k8s/kubernetes.service'
import { PodExecFactory } from '@/modules/k8s/pod-exec'
import { teardownCreatedPodHost } from '@/modules/agents/orchestration/k8s-strict-teardown'
import {
    buildPodHostDeployment,
    buildPodHostPvc,
    buildPodHostSecret,
    podHostFrameworkIngressHost,
    podHostResourceName,
    type PodHostSpec
} from '@/modules/agent-runtimes/provisioning/pod-host-resources'
import { HostsService } from '../hosts.service'
import { HostProviderClients } from './host-provider-clients.service'
import {
    SandboxProviderRegistry,
    type HostCreateSpec,
    type ProviderCall,
    type ProviderExecResult,
    type SandboxProvider,
    type SandboxProviderCapabilities
} from './sandbox-provider'
import { assertCurrentGeneration, patchProviderRef } from './generation'

const DEFAULT_HOST_SUFFIX = '18.135.81.53.nip.io'
const DEFAULT_STORAGE_CLASS = 'standard'
const HOST_TEARDOWN_TIMEOUT_MS = 180_000
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 180_000

// A pod's phase as the host's power: a pod is either up or it is not, and
// nothing in between is a state the user can act on.
export const podPowerState = (phase: string | null): RuntimeHostPowerState => {
    switch (phase) {
        case 'Running':
            return 'running'
        case 'Pending':
            return 'unknown'
        case null:
        case 'Failed':
        case 'Succeeded':
            return 'stopped'
        default:
            return 'unknown'
    }
}

// The host's hostname is `<resource>.<suffix>`; a framework's shares the suffix.
export const ingressSuffixOf = (
    hostId: string,
    hostIngress: string | null
): string => {
    const prefix = `${podHostResourceName(hostId)}.`
    if (!hostIngress?.startsWith(prefix))
        throw new Error(`cloud computer ${hostId} has no ingress host`)
    return hostIngress.slice(prefix.length)
}

// The Kubernetes adapter (ADR-0035, ADR-0036): a hosted host on a cluster is
// one Deployment + PVC + Secret in the user's namespace. Its provider_ref is
// { namespace, ingressHost, podPhase }; the kubeconfig is the provider row's.
@Injectable()
export class K8sProvider implements SandboxProvider {
    readonly kind = 'k8s' as const
    readonly capabilities: SandboxProviderCapabilities = {
        suspend: false,
        publicService: true
    }
    constructor(
        registry: SandboxProviderRegistry,
        private readonly hosts: HostsService,
        private readonly config: ConfigService,
        private readonly k8s: KubernetesService,
        private readonly podExec: PodExecFactory,
        private readonly clients: HostProviderClients
    ) {
        registry.register(this)
    }

    private ref(call: Pick<ProviderCall, 'host'>): K8sProviderRef | null {
        const ref = call.host.providerRef
        return ref && ref.kind === 'k8s' ? ref : null
    }

    private client(call: Pick<ProviderCall, 'provider'>): Promise<K8sClient> {
        return this.clients.k8sClientForProvider(call.provider)
    }

    private hostImage(): string {
        const image = this.config.get<string>('K8S_RUNTIME_IMAGE')
        if (!image) throw new Error('K8S_RUNTIME_IMAGE is not set')
        return image
    }

    // Each object is created once; a 409 means an earlier run under the same
    // generation already made it, which is the idempotence the fence promises.
    async create(
        args: ProviderCall & { spec: HostCreateSpec }
    ): Promise<RuntimeHostProviderRef> {
        await assertCurrentGeneration(this.hosts, args.host, args.generation)
        const client = await this.client(args)
        const namespace =
            this.ref(args)?.namespace ??
            (await this.k8s.ensureUserNamespace(client, args.host.userId))
        const suffix =
            client.hostSuffix ??
            this.config.get<string>('K8S_INGRESS_HOST_SUFFIX') ??
            DEFAULT_HOST_SUFFIX
        const ingressHost = `${podHostResourceName(args.host.id)}.${suffix}`
        const spec: PodHostSpec = {
            hostId: args.host.id,
            userId: args.host.userId,
            namespace,
            image: this.hostImage(),
            storageClass:
                this.config.get<string>('K8S_STORAGE_CLASS') ??
                DEFAULT_STORAGE_CLASS,
            storageSize: `${args.spec.diskGb ?? args.host.diskGb ?? 10}Gi`,
            resources: {
                requests: {
                    cpu: `${args.spec.cpuMillicores ?? args.host.cpuMillicores ?? 500}m`,
                    memory: `${args.spec.memoryMb ?? args.host.memoryMb ?? 1024}Mi`
                },
                limits: {
                    cpu: `${args.spec.cpuMillicores ?? args.host.cpuMillicores ?? 500}m`,
                    memory: `${args.spec.memoryMb ?? args.host.memoryMb ?? 1024}Mi`
                }
            }
        }
        const ref: K8sProviderRef = {
            kind: 'k8s',
            namespace,
            ingressHost,
            podPhase: null
        }
        await this.hosts.setProviderRef(args.host.id, ref)
        const { apis } = client
        const options = args.fence?.requestOptions as
            | ConfigurationOptions
            | undefined
        const create = async (work: () => Promise<unknown>): Promise<void> => {
            await args.fence?.assertActive()
            try {
                await work()
            } catch (err) {
                if (!isApiConflict(err)) throw err
            }
        }
        await create(() =>
            apis.core.createNamespacedSecret(
                {
                    namespace,
                    body: buildPodHostSecret(spec, args.spec.env ?? {})
                },
                options
            )
        )
        await create(() =>
            apis.core.createNamespacedPersistentVolumeClaim(
                { namespace, body: buildPodHostPvc(spec) },
                options
            )
        )
        await create(() =>
            apis.apps.createNamespacedDeployment(
                { namespace, body: buildPodHostDeployment(spec) },
                options
            )
        )
        return ref
    }

    async destroy(args: ProviderCall): Promise<void> {
        await assertCurrentGeneration(this.hosts, args.host, args.generation)
        const ref = this.ref(args)
        if (!ref) return
        const client = await this.client(args)
        await teardownCreatedPodHost({
            apis: client.apis,
            namespace: ref.namespace,
            hostId: args.host.id,
            signal:
                args.fence?.signal ?? AbortSignal.timeout(HOST_TEARDOWN_TIMEOUT_MS)
        })
    }

    async power(
        args: Omit<ProviderCall, 'generation'>
    ): Promise<RuntimeHostPowerState> {
        const ref = this.ref(args)
        if (!ref) return 'unknown'
        const client = await this.client(args)
        const pod = await this.k8s.findHostPodIfAny(
            client,
            args.host.id,
            ref.namespace
        )
        const phase = pod?.phase ?? null
        if (phase !== ref.podPhase)
            await patchProviderRef<K8sProviderRef>(this.hosts, args.host.id, {
                podPhase: phase
            })
        return podPowerState(phase)
    }

    // A Deployment keeps its pod up; there is nothing to wake.
    async wake(args: ProviderCall): Promise<void> {
        await assertCurrentGeneration(this.hosts, args.host, args.generation)
    }

    // A login-shell script on the pod's stdin: pod exec carries no env, and
    // argv would show in the pod's /proc.
    async bootstrap(
        args: ProviderCall & {
            script: string
            stdin?: string
            timeoutMs?: number
        }
    ): Promise<ProviderExecResult> {
        await assertCurrentGeneration(this.hosts, args.host, args.generation)
        const ref = this.ref(args)
        if (!ref) throw new Error(`cloud computer ${args.host.id} has no pod`)
        const client = await this.client(args)
        const pod = await this.k8s.findHostPod(client, args.host.id, ref.namespace)
        const exec = this.podExec.forClient(
            client,
            ref.namespace,
            pod.podName,
            pod.containerName
        )
        // A script with its own stdin (the register token) rides argv; one
        // without is fed on stdin so nothing of it shows in the pod's /proc.
        return exec.run({
            cmd:
                args.stdin !== undefined
                    ? ['bash', '-lc', args.script]
                    : ['bash', '-l', '-s'],
            stdin: args.stdin ?? `${args.script}\n`,
            timeoutMs: args.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS
        })
    }

    publicUrl(
        args: Omit<ProviderCall, 'generation'> & {
            framework: string
            port: number
        }
    ): string | null {
        const ref = this.ref(args)
        if (!ref?.ingressHost) return null
        return `https://${podHostFrameworkIngressHost(
            args.host.id,
            args.framework,
            ingressSuffixOf(args.host.id, ref.ingressHost)
        )}`
    }
}
