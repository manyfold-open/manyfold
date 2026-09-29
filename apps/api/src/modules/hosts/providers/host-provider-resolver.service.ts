import { Injectable, NotFoundException } from '@nestjs/common'
import type { RuntimeHostRow, RuntimeProvider } from '@manyfold/db'
import { RuntimeProvidersService } from '../runtime-providers.service'
import { HostProviderClients } from './host-provider-clients.service'
import {
    SandboxProviderRegistry,
    type SandboxProvider
} from './sandbox-provider'

// A provider row is read once per minute per provider: the turn path asks on
// every bring-up, and the row changes only through the admin surface, which
// invalidates it.
const PROVIDER_CACHE_TTL_MS = 60_000

export interface ResolvedHostProvider {
    provider: RuntimeProvider
    adapter: SandboxProvider
}

// The provider a hosted host lives on, and its adapter (ADR-0037): the way
// the core reaches a machine's lifecycle without knowing which provider it is.
@Injectable()
export class HostProviderResolver {
    private readonly cache = new Map<
        string,
        { provider: RuntimeProvider; expiresAt: number }
    >()

    constructor(
        private readonly providers: RuntimeProvidersService,
        private readonly registry: SandboxProviderRegistry,
        private readonly clients: HostProviderClients
    ) {}

    async providerForHost(host: RuntimeHostRow): Promise<RuntimeProvider> {
        if (host.kind !== 'hosted' || !host.providerId)
            throw new NotFoundException(`host ${host.id} is not a hosted host`)
        const cached = this.cache.get(host.providerId)
        if (cached && cached.expiresAt > Date.now()) return cached.provider
        const provider = await this.providers.findById(host.providerId)
        if (!provider)
            throw new NotFoundException(
                `runtime provider ${host.providerId} not found for host ${host.id}`
            )
        this.cache.set(provider.id, {
            provider,
            expiresAt: Date.now() + PROVIDER_CACHE_TTL_MS
        })
        return provider
    }

    async resolve(host: RuntimeHostRow): Promise<ResolvedHostProvider> {
        const provider = await this.providerForHost(host)
        return { provider, adapter: this.registry.for(provider.kind) }
    }

    adapterFor(provider: Pick<RuntimeProvider, 'kind'>): SandboxProvider {
        return this.registry.for(provider.kind)
    }

    // Every registered adapter, for the passes that go over all providers.
    adapters(): SandboxProvider[] {
        return this.registry.kinds().map((kind) => this.registry.for(kind))
    }

    // After the provider row or its credential changed: the row and every
    // client built from it are read again.
    invalidate(provider: Pick<RuntimeProvider, 'id' | 'kind'>): void {
        this.cache.delete(provider.id)
        this.clients.invalidateProvider(provider.id)
        if (this.registry.has(provider.kind))
            this.registry.for(provider.kind).forget?.(provider.id)
    }
}
