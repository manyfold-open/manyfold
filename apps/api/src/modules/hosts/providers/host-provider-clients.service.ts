import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import type {
    RuntimeHostRow,
    RuntimeProvider,
    SpritesProviderRef
} from '@manyfold/db'
import {
    createClient,
    execSprite,
    type ExecOptions,
    type ExecResult,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { KubernetesService, type K8sClient } from '@/modules/k8s/kubernetes.service'
import { RuntimeProvidersService } from '../runtime-providers.service'

// One command on the machine through the provider's own exec, answered with
// exit code and output.
export interface HostExecFn {
    (args: {
        cmd: string[]
        env?: Record<string, string>
        stdin?: string
        timeoutMs: number
    }): Promise<{ exitCode: number; stdout: string; stderr: string }>
}

// A provider row is read once per minute per provider: the credential is
// decrypted on every client build, and the turn path asks for one per exec.
const PROVIDER_CACHE_TTL_MS = 60_000

// The provider-native clients the adapters are built on: a sprites
// organisation's REST and exec client, a cluster's Kubernetes client, each
// from the provider row's credential. Only the adapters (hosts/providers)
// use them; the rest of the API reaches a provider through its adapter.
@Injectable()
export class HostProviderClients {
    private readonly log = new Logger(HostProviderClients.name)
    private readonly providerCache = new Map<
        string,
        { provider: RuntimeProvider; expiresAt: number }
    >()

    constructor(
        private readonly providers: RuntimeProvidersService,
        private readonly crypto: CryptoService,
        private readonly k8s: KubernetesService
    ) {}

    credentialFor(provider: RuntimeProvider): string {
        return this.crypto.decrypt({
            ciphertext: provider.credentialCiphertext,
            keyVersion: provider.credentialKeyVersion
        })
    }

    async providerForHost(host: RuntimeHostRow): Promise<RuntimeProvider> {
        if (host.kind !== 'hosted' || !host.providerId)
            throw new NotFoundException(
                `host ${host.id} is not a hosted host`
            )
        const cached = this.providerCache.get(host.providerId)
        if (cached && cached.expiresAt > Date.now()) return cached.provider
        const provider = await this.providers.findById(host.providerId)
        if (!provider)
            throw new NotFoundException(
                `runtime provider ${host.providerId} not found for host ${host.id}`
            )
        this.providerCache.set(provider.id, {
            provider,
            expiresAt: Date.now() + PROVIDER_CACHE_TTL_MS
        })
        return provider
    }

    invalidateProvider(providerId: string): void {
        this.providerCache.delete(providerId)
    }

    private spritesRef(host: RuntimeHostRow): SpritesProviderRef {
        const ref = host.providerRef
        if (!ref || ref.kind !== 'sprites')
            throw new NotFoundException(
                `host ${host.id} has no sprite (provider ref ${ref?.kind ?? 'none'})`
            )
        return ref
    }

    spritesClientForProvider(
        provider: RuntimeProvider,
        logger?: SpritesLogger
    ): SpritesClient {
        if (provider.kind !== 'sprites')
            throw new Error(`runtime provider ${provider.id} is not sprites`)
        return createClient({
            token: this.credentialFor(provider),
            accountSlug: provider.name,
            logger
        })
    }

    async spritesClientForHost(
        host: RuntimeHostRow,
        logger?: SpritesLogger
    ): Promise<{
        client: SpritesClient
        spriteName: string
        provider: RuntimeProvider
    }> {
        const ref = this.spritesRef(host)
        const provider = await this.providerForHost(host)
        return {
            client: this.spritesClientForProvider(provider, logger),
            spriteName: ref.spriteName,
            provider
        }
    }

    // Test seam: the sprite exec opens a real WebSocket.
    protected execSprite(
        client: SpritesClient,
        spriteName: string,
        opts: ExecOptions,
        logger?: SpritesLogger
    ): Promise<ExecResult> {
        return execSprite(client, spriteName, opts, logger)
    }

    async spriteExecForHost(
        host: RuntimeHostRow,
        logger?: SpritesLogger
    ): Promise<HostExecFn> {
        const { client, spriteName } = await this.spritesClientForHost(
            host,
            logger
        )
        return (args) =>
            this.execSprite(
                client,
                spriteName,
                {
                    cmd: args.cmd,
                    ...(args.env ? { env: args.env } : {}),
                    stdin: args.stdin ?? '',
                    timeoutMs: args.timeoutMs
                },
                logger
            )
    }

    async k8sClientForProvider(provider: RuntimeProvider): Promise<K8sClient> {
        if (provider.kind !== 'k8s')
            throw new Error(`runtime provider ${provider.id} is not k8s`)
        return this.k8s.getClient(provider.id)
    }

    spritesLoggerFor(log: Logger = this.log): SpritesLogger {
        return {
            debug: (m, meta) =>
                log.debug?.(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
            info: (m, meta) =>
                log.log(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
            warn: (m, meta) =>
                log.warn(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
            error: (m, meta) =>
                log.error(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`)
        }
    }
}
