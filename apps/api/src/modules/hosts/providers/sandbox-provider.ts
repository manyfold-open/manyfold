import { Inject, Injectable } from '@nestjs/common'
import type { RuntimeProviderKind } from '@manyfold/shared'
import type {
    RuntimeHostPowerState,
    RuntimeHostProviderRef,
    RuntimeHostRow,
    RuntimeProvider
} from '@manyfold/db'

// What a runtime provider must implement (ADR-0036): the machine's lifecycle
// and a single bootstrap that installs `mf`, writes the host's bound token and
// starts the daemon. Everything that happens inside the machine afterwards
// goes through the host daemon's RPC and is provider-agnostic.
//
// Every mutating call is idempotent on (host.id, generation): running it twice
// under the same generation yields the same result, and a call made under an
// older generation than the host's current one must be a no-op.
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
}

export interface ProviderCall {
    host: RuntimeHostRow
    provider: RuntimeProvider
    generation: number
}

export interface SandboxProvider {
    readonly kind: RuntimeProviderKind
    readonly capabilities: SandboxProviderCapabilities
    create(args: ProviderCall & { spec: HostCreateSpec }): Promise<RuntimeHostProviderRef>
    destroy(args: ProviderCall): Promise<void>
    power(args: Omit<ProviderCall, 'generation'>): Promise<RuntimeHostPowerState>
    wake(args: ProviderCall): Promise<void>
    suspend?(args: ProviderCall): Promise<void>
    bootstrap(args: ProviderCall & { script: string }): Promise<void>
    publicUrl?(args: Omit<ProviderCall, 'generation'> & { port: number }): string | null
}

export const SANDBOX_PROVIDERS = Symbol('SANDBOX_PROVIDERS')

@Injectable()
export class SandboxProviderRegistry {
    private readonly byKind = new Map<RuntimeProviderKind, SandboxProvider>()

    constructor(@Inject(SANDBOX_PROVIDERS) providers: SandboxProvider[]) {
        for (const provider of providers) this.byKind.set(provider.kind, provider)
    }

    for(kind: RuntimeProviderKind): SandboxProvider {
        const provider = this.byKind.get(kind)
        if (!provider) throw new Error(`no sandbox provider registered for ${kind}`)
        return provider
    }

    kinds(): RuntimeProviderKind[] {
        return [...this.byKind.keys()]
    }
}
