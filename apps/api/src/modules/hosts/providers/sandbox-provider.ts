import { Injectable, Logger } from '@nestjs/common'
import type { RuntimeProviderKind } from '@manyfold/shared'
import type {
    RuntimeHostPowerState,
    RuntimeHostProviderRef,
    RuntimeHostRow,
    RuntimeProvider
} from '@manyfold/db'

// What a runtime provider must implement (ADR-0037): the machine's lifecycle
// and a single bootstrap channel that installs `mf`, writes the host's bound
// token and starts the daemon. Everything that happens inside the machine
// afterwards goes through the host daemon's RPC and is provider-agnostic.
//
// Every mutating call is idempotent on (host.id, generation): running it twice
// under the same generation yields the same result, and a call made under an
// older generation than the host's current one is dropped
// (StaleGenerationError).
export interface SandboxProviderCapabilities {
    // The machine can be suspended and woken (sprites); pods cannot.
    suspend: boolean
    // Service frameworks get a public entry (publicUrl).
    publicService: boolean
}

export interface HostCreateSpec {
    name: string
    region?: string | null
    cpuMillicores?: number | null
    memoryMb?: number | null
    diskGb?: number | null
    // What the machine boots with (a pod's env Secret: the daemon's bound
    // token and the API URL). Providers whose machines start bare ignore it.
    env?: Record<string, string>
}

// What a caller that can lose the right to mutate mid-call hands the adapter
// (a fresh create whose ownership lease may lapse): checked before every
// remote mutation, and its signal bounds the remote requests.
export interface ProviderCallFence {
    assertActive(): Promise<void>
    signal?: AbortSignal
    // Provider-specific per-request options (a Kubernetes client's
    // middleware that stamps each request with the owner's deadline and
    // records it as uncertain until it answers); opaque to the core.
    requestOptions?: unknown
}

export interface ProviderCall {
    host: RuntimeHostRow
    provider: RuntimeProvider
    generation: number
    fence?: ProviderCallFence
}

export interface ProviderExecResult {
    exitCode: number
    stdout: string
    stderr: string
}

export interface SandboxProvider {
    readonly kind: RuntimeProviderKind
    readonly capabilities: SandboxProviderCapabilities
    create(
        args: ProviderCall & { spec: HostCreateSpec }
    ): Promise<RuntimeHostProviderRef>
    destroy(args: ProviderCall): Promise<void>
    power(args: Omit<ProviderCall, 'generation'>): Promise<RuntimeHostPowerState>
    wake(args: ProviderCall): Promise<void>
    suspend?(args: ProviderCall): Promise<void>
    // The provider-native exec: a login-shell script run inside the machine.
    // The only thing it is for is the daemon's own bring-up (install `mf`,
    // register with the bound token, start) and the read-only probes around
    // it; framework installs and everything else go through the daemon.
    bootstrap(
        args: ProviderCall & {
            script: string
            stdin?: string
            timeoutMs?: number
        }
    ): Promise<ProviderExecResult>
    // The provider's activity lease (ADR-0038): while it is held the machine is
    // not suspended, and acquiring it resumes a suspended machine. Create or
    // renew, so a retry is not a failure. Providers whose machines never sleep
    // leave both out and the core holds nothing.
    holdAwake?(
        args: Omit<ProviderCall, 'generation'>,
        lease: { name: string; ttl: string }
    ): Promise<void>
    releaseAwake?(
        args: Omit<ProviderCall, 'generation'>,
        lease: { name: string }
    ): Promise<void>
    publicUrl?(
        args: Omit<ProviderCall, 'generation'> & {
            framework: string
            port: number
        }
    ): string | null
}

export class StaleGenerationError extends Error {
    constructor(hostId: string, generation: number, current: number) {
        super(
            `host ${hostId} generation ${generation} is stale (current ${current})`
        )
        this.name = 'StaleGenerationError'
    }
}

// Adapters register themselves from their module constructor, the way
// CapabilitiesRegistry entries do, so HostsModule stays free of adapter
// imports and an edition can add a provider without touching the core list.
@Injectable()
export class SandboxProviderRegistry {
    private readonly log = new Logger(SandboxProviderRegistry.name)
    private readonly byKind = new Map<RuntimeProviderKind, SandboxProvider>()

    register(provider: SandboxProvider): void {
        if (this.byKind.has(provider.kind))
            throw new Error(
                `sandbox provider '${provider.kind}' registered twice`
            )
        this.byKind.set(provider.kind, provider)
        this.log.log(`sandbox provider registered kind=${provider.kind}`)
    }

    for(kind: RuntimeProviderKind): SandboxProvider {
        const provider = this.byKind.get(kind)
        if (!provider) throw new Error(`no sandbox provider registered for ${kind}`)
        return provider
    }

    has(kind: RuntimeProviderKind): boolean {
        return this.byKind.has(kind)
    }

    kinds(): RuntimeProviderKind[] {
        return [...this.byKind.keys()]
    }
}
