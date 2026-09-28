import { Injectable, Logger } from '@nestjs/common'
import {
    SpritesError,
    parseTaskList,
    type Sprite,
    type SpriteTask,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import type {
    RuntimeHostPowerState,
    RuntimeHostProviderRef,
    SpritesProviderRef
} from '@manyfold/db'
import { defaultNetworkPolicy } from '@/modules/agents/orchestration/bootstrap-invariants'
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
import { assertCurrentGeneration } from './generation'

const WAKE_TIMEOUT_MS = 60_000
const AWAKE_LEASE_TIMEOUT_MS = 60_000

// A /v1/tasks `expire` value (`30m`) in ms; null for a form this does not read.
const ttlMs = (ttl: string): number | null => {
    const match = /^(\d+)([smh])$/.exec(ttl)
    if (!match) return null
    const unit = { s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as 's' | 'm' | 'h']
    return Number(match[1]) * unit
}

// A listed task holds for a TTL taken at `since` when at least half of that
// TTL is still ahead of it; one listed without an expiry is taken at its word.
const holdsFor = (task: SpriteTask, ttl: string, since: number): boolean => {
    const ms = ttlMs(ttl)
    const expiresAt = task.expiresAt ? Date.parse(task.expiresAt) : Number.NaN
    return ms === null || !Number.isFinite(expiresAt) || expiresAt >= since + ms / 2
}

const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 180_000

// The sprite is named after the host so a retry under the same generation
// finds the machine it already made instead of making another.
export const spriteNameForHost = (hostId: string): string =>
    hostId.replace(/_/g, '-')

export const isSpritesNotFound = (err: unknown): boolean =>
    err instanceof SpritesError && err.code === 'not_found'

// sprites.dev reports running / warm / cold; the host's power vocabulary is
// provider-neutral.
export const spritePowerState = (status: string | null | undefined): RuntimeHostPowerState => {
    switch (status) {
        case 'running':
            return 'running'
        case 'warm':
            return 'suspended'
        case 'cold':
            return 'stopped'
        default:
            return 'unknown'
    }
}

// The sprites.dev adapter (ADR-0037): a hosted host on a sprites organisation
// is one sprite VM. Its provider_ref is { spriteName, spriteId }; the
// organisation credential is the provider row's.
@Injectable()
export class SpritesProvider implements SandboxProvider {
    readonly kind = 'sprites' as const
    readonly capabilities: SandboxProviderCapabilities = {
        suspend: true,
        publicService: true
    }
    private readonly log = new Logger(SpritesProvider.name)

    constructor(
        registry: SandboxProviderRegistry,
        private readonly hosts: HostsService,
        private readonly clients: HostProviderClients
    ) {
        registry.register(this)
    }

    private client(call: Pick<ProviderCall, 'provider'>): SpritesClient {
        return this.clients.spritesClientForProvider(
            call.provider,
            this.spritesLogger()
        )
    }

    private spritesLogger(): SpritesLogger {
        return this.clients.spritesLoggerFor(this.log)
    }

    private ref(call: Pick<ProviderCall, 'host'>): SpritesProviderRef | null {
        const ref = call.host.providerRef
        return ref && ref.kind === 'sprites' ? ref : null
    }

    async create(
        args: ProviderCall & { spec: HostCreateSpec }
    ): Promise<RuntimeHostProviderRef> {
        await assertCurrentGeneration(this.hosts, args.host, args.generation)
        const client = this.client(args)
        const spriteName =
            this.ref(args)?.spriteName ?? spriteNameForHost(args.host.id)
        let sprite: Sprite | null = null
        try {
            sprite = await client.getSprite(spriteName)
        } catch (err) {
            if (!isSpritesNotFound(err)) throw err
        }
        if (!sprite) sprite = await client.createSprite({ name: spriteName })
        await client.setNetworkPolicy(spriteName, defaultNetworkPolicy())
        const ref: SpritesProviderRef = {
            kind: 'sprites',
            spriteName,
            spriteId: typeof sprite.id === 'string' ? sprite.id : null
        }
        await this.hosts.setProviderRef(args.host.id, ref)
        return ref
    }

    async destroy(args: ProviderCall): Promise<void> {
        await assertCurrentGeneration(this.hosts, args.host, args.generation)
        const ref = this.ref(args)
        if (!ref) return
        await this.client(args)
            .deleteSprite(ref.spriteName)
            .catch((err) => {
                if (!isSpritesNotFound(err)) throw err
            })
    }

    async power(
        args: Omit<ProviderCall, 'generation'>
    ): Promise<RuntimeHostPowerState> {
        const ref = this.ref(args)
        if (!ref) return 'unknown'
        try {
            const sprite = await this.client(args).getSprite(ref.spriteName)
            return spritePowerState(sprite.status)
        } catch (err) {
            if (isSpritesNotFound(err)) return 'unknown'
            throw err
        }
    }

    // /v1/tasks is the platform's own activity lease, reachable only from
    // inside the VM, so the exec that posts it is also what resumes a
    // suspended sprite. The path goes straight after -X and BEFORE -d, with no
    // -H/-o/-w: anything else makes curl exit 3 and the hold silently never
    // happens (seen on staging 2026-07). Measured on local [2026-09-28]: a PUT
    // creates a missing task and renews an existing one (a POST on an existing
    // name answers 409, and `sprite-env curl -s` exits 22 on it), a DELETE of
    // a missing task exits 0, and names of 64 characters are accepted. So one
    // PUT is the create-or-renew, and the listing after it is the proof: the
    // hold counts once its name is listed with at least half its TTL ahead.
    async holdAwake(
        args: Omit<ProviderCall, 'generation'>,
        lease: { name: string; ttl: string }
    ): Promise<void> {
        const since = Date.now()
        const listed = await this.listAfter(
            args,
            `sprite-env curl -s -X PUT ${shellQuote(`/v1/tasks/${lease.name}`)} -d ${shellQuote(JSON.stringify({ expire: lease.ttl }))}`
        )
        const held = listed?.find((task) => task.name === lease.name)
        if (!held)
            throw new Error(
                `sprite awake lease ${lease.name} is not listed after its renew`
            )
        if (!holdsFor(held, lease.ttl, since))
            throw new Error(
                `sprite awake lease ${lease.name} was not renewed (expires ${held.expiresAt})`
            )
    }

    // Confirmed the same way: by a listing without the name.
    async releaseAwake(
        args: Omit<ProviderCall, 'generation'>,
        lease: { name: string }
    ): Promise<void> {
        const listed = await this.listAfter(
            args,
            `sprite-env curl -s -X DELETE ${shellQuote(`/v1/tasks/${lease.name}`)}`
        )
        if (!listed || listed.some((task) => task.name === lease.name))
            throw new Error(
                `sprite awake lease ${lease.name} is still listed after its delete`
            )
    }

    // One exec: the task call, then the listing it is proven by (null when the
    // output is not a listing).
    private async listAfter(
        args: Omit<ProviderCall, 'generation'>,
        call: string
    ): Promise<SpriteTask[] | null> {
        const exec = await this.clients.spriteExecForHost(
            args.host,
            this.spritesLogger()
        )
        const res = await exec({
            cmd: [
                'bash',
                '-lc',
                `${call} >/dev/null 2>&1; sprite-env curl -s /v1/tasks`
            ],
            timeoutMs: AWAKE_LEASE_TIMEOUT_MS
        })
        return parseTaskList(res.stdout)
    }

    // Any exec resumes a suspended sprite; a no-op command is the cheapest.
    async wake(args: ProviderCall): Promise<void> {
        await this.bootstrap({
            ...args,
            script: 'true',
            timeoutMs: WAKE_TIMEOUT_MS
        })
    }

    async bootstrap(
        args: ProviderCall & {
            script: string
            stdin?: string
            timeoutMs?: number
        }
    ): Promise<ProviderExecResult> {
        await assertCurrentGeneration(this.hosts, args.host, args.generation)
        const exec = await this.clients.spriteExecForHost(
            args.host,
            this.spritesLogger()
        )
        return exec({
            cmd: ['bash', '-lc', args.script],
            stdin: args.stdin,
            timeoutMs: args.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS
        })
    }

    // A sprite's public URL is `https://<sprite name>.sprites.app`; the
    // service bootstraps read the authoritative one back from the sprite
    // object, which is what the runtime's ingress derives from.
    publicUrl(
        args: Omit<ProviderCall, 'generation'> & {
            framework: string
            port: number
        }
    ): string | null {
        const ref = this.ref(args)
        return ref ? `https://${ref.spriteName}.sprites.app` : null
    }
}
