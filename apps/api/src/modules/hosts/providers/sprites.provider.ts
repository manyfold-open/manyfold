import { Injectable, Logger } from '@nestjs/common'
import { SANDBOX_PORT_SERVICE } from '@manyfold/shared'
import {
    SpritesError,
    parseTaskList,
    type ServiceDef,
    type NetworkPolicy,
    type ServiceObject,
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
import { HostsService } from '../hosts.service'
import { HostProviderClients } from './host-provider-clients.service'
import {
    SandboxProviderRegistry,
    type ExecEndpointFailure,
    type HostCreateSpec,
    type ProviderCall,
    type ProviderErrorFacts,
    type ProviderExecResult,
    type SandboxProvider,
    type SandboxProviderCapabilities,
    type SupervisedProcess
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

// What a stored service definition is compared on: a PUT never changes an
// existing one, so a difference means delete and PUT again.
const sameDefinition = (current: ServiceObject, next: ServiceDef): boolean =>
    current.cmd === next.cmd &&
    JSON.stringify(current.args ?? []) === JSON.stringify(next.args ?? []) &&
    JSON.stringify(sortedEnv(current.env)) ===
        JSON.stringify(sortedEnv(next.env)) &&
    (current.http_port ?? null) === (next.http_port ?? null)

const sortedEnv = (
    env: Record<string, string> | undefined
): Array<[string, string]> =>
    Object.entries(env ?? {}).sort(([a], [b]) => a.localeCompare(b))

// sprites.dev treats an empty rule list as wide-open outbound access.
export const defaultNetworkPolicy = (): NetworkPolicy => ({ rules: [] })

const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 180_000

// The sprite is named after the host so a retry under the same generation
// finds the machine it already made instead of making another.
export const spriteNameForHost = (hostId: string): string =>
    hostId.replace(/_/g, '-')

export const isSpritesNotFound = (err: unknown): boolean =>
    err instanceof SpritesError && err.code === 'not_found'

// Which exec failures are the EXEC ENDPOINT's fault. Getting this wrong in the
// generous direction is expensive: the caller quarantines on it, so a class
// handed out for a sprite that answered takes a healthy VM out of the turn path.
//
// Only a transient SpritesError qualifies at all. `auth` is an account-wide fact
// (a revoked account token would quarantine every sprite on that account at
// once, none of them sick), and not_found / conflict / quota / permanent are
// facts about the request. A structured `reason` — today `exec_session_gone` —
// means the endpoint started and reaped a session, so it answered.
const execEndpointFailure = (err: SpritesError): ExecEndpointFailure | null => {
    if (err.code !== 'transient' || err.reason) return null
    if (err.execPhase !== 'pre_open') return null
    // The exec burned its whole budget without a result: nothing usable came
    // back from the endpoint within a window many times what a healthy one needs.
    if (/timed out after \d+ms/i.test(err.message))
        return { failureClass: 'timeout' }
    const status = err.status
    // A non-101 upgrade response. 5xx only: the socket never opened AND the
    // backend blamed itself.
    if (status !== undefined && status >= 500 && /handshake/i.test(err.message))
        return {
            failureClass: 'handshake_5xx',
            upstreamStatus: status
        }
    // `ws` reports a connection that died before the handshake completed as an
    // error with no status. A socket that opened and then died surfaces as
    // `closed without exit code` instead, which is deliberately NOT classified:
    // a sprite suspending mid-exec does that and recovers by itself.
    if (/transport error/i.test(err.message))
        return { failureClass: 'transport_error' }
    return null
}

export const spritesErrorFacts = (err: unknown): ProviderErrorFacts | null =>
    err instanceof SpritesError
        ? {
              errorClass: `sprites:${err.code}`,
              beforeOpen:
                  err.code === 'transient' && err.execPhase === 'pre_open',
              execFailure: execEndpointFailure(err)
          }
        : null

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
            spriteId: typeof sprite.id === 'string' ? sprite.id : null,
            url: typeof sprite.url === 'string' && sprite.url ? sprite.url : null
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

    // Measured on local [2026-09-29]: a service's processes live in a cgroup
    // of its own, and the service counts as running — and is never restarted —
    // while anything is left in it, so the daemon's children would keep a
    // dead daemon's service up; the command is a loop that restarts the
    // daemon instead. A PUT on an existing service keeps its old command and
    // env, stopped or not, and a delete kills everything in its cgroup. Every
    // defined service starts again when the sprite's environment restarts
    // (a checkpoint restore, a cold boot), which is the point of it.
    async superviseDaemon(
        args: ProviderCall,
        process: SupervisedProcess
    ): Promise<void> {
        await assertCurrentGeneration(this.hosts, args.host, args.generation)
        const spriteName = this.requireRef(args).spriteName
        const [cmd, ...rest] = process.command
        await this.ensureService(this.client(args), spriteName, process.name, {
            cmd,
            args: rest,
            env: process.env
        })
    }

    // The public URL goes to whatever listens on the port a service declares
    // as its http_port, one such service per sprite; a stub declares it for
    // a port the daemon's service serves (measured on local [2026-09-28],
    // HTTP and WebSocket, and an inbound request wakes a suspended sprite).
    // The framework authenticates its own callers (a gateway token, an API
    // key), so the URL is public. The URL is read back from the sprite: its
    // hostname carries the organisation's suffix.
    async publishPort(
        args: Omit<ProviderCall, 'generation'>,
        port: number | null
    ): Promise<void> {
        const ref = this.requireRef(args)
        const client = this.client(args)
        if (port === null) {
            await client
                .deleteService(ref.spriteName, SANDBOX_PORT_SERVICE)
                .catch((err) => {
                    if (!isSpritesNotFound(err)) throw err
                })
            return
        }
        await this.ensureService(client, ref.spriteName, SANDBOX_PORT_SERVICE, {
            cmd: 'sleep',
            args: ['infinity'],
            http_port: port
        })
        await client.updateSprite(ref.spriteName, {
            url_settings: { auth: 'public' }
        })
        const sprite = await client.getSprite(ref.spriteName)
        const url = typeof sprite.url === 'string' && sprite.url ? sprite.url : null
        if (url && url !== ref.url)
            await this.hosts.setProviderRef(args.host.id, { ...ref, url })
    }

    private async ensureService(
        client: SpritesClient,
        spriteName: string,
        name: string,
        def: ServiceDef
    ): Promise<void> {
        const current = await client
            .getService(spriteName, name)
            .catch((err) => {
                if (isSpritesNotFound(err)) return null
                throw err
            })
        const same = current !== null && sameDefinition(current, def)
        if (current && !same) await client.deleteService(spriteName, name)
        if (!same) await client.upsertService(spriteName, name, def)
        if (!same || current?.state?.status !== 'running')
            await client.startService(spriteName, name)
    }

    private requireRef(args: Pick<ProviderCall, 'host'>): SpritesProviderRef {
        const ref = this.ref(args)
        if (!ref) throw new Error(`host ${args.host.id} has no sprite`)
        return ref
    }

    describeError(err: unknown): ProviderErrorFacts | null {
        return spritesErrorFacts(err)
    }

    // The URL the sprite reported when it was made or its port was published.
    publicUrl(
        args: Omit<ProviderCall, 'generation'> & {
            framework: string
            port: number
        }
    ): string | null {
        return this.ref(args)?.url ?? null
    }
}
