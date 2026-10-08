import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import {
    SANDBOX_PORT_SERVICE,
    type SandboxHealthVerdict
} from '@manyfold/shared'
import {
    SpritesError,
    parseTaskList,
    type ExecSessionInfo,
    type ServiceDef,
    type NetworkPolicy,
    type ServiceListResponse,
    type ServiceObject,
    type Sprite,
    type SpriteTask,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import type {
    RuntimeHostPowerState,
    RuntimeHostProviderRef,
    RuntimeHostRow,
    RuntimeProvider,
    RuntimeProviderConfig,
    SpritesProviderConfig,
    SpritesProviderRef
} from '@manyfold/db'
import { HostsService } from '../hosts.service'
import { HostProviderClients } from './host-provider-clients.service'
import {
    AwakeLeaseStillHeldError,
    SandboxProviderRegistry,
    type AwakeLease,
    type CredentialHealth,
    type ExecEndpointFailure,
    type HostCreateSpec,
    type ProviderCall,
    type PreparedCredential,
    type ProviderErrorFacts,
    type ProviderExecResult,
    type ProviderHealthReport,
    type ProviderObservation,
    type ProviderPowerState,
    type ProviderService,
    type ReapedSession,
    type SandboxProvider,
    type SandboxProviderCapabilities,
    type SupervisedProcess
} from './sandbox-provider'
import { assertCurrentGeneration } from './generation'

const WAKE_TIMEOUT_MS = 60_000
const AWAKE_LEASE_TIMEOUT_MS = 60_000
const AWAKE_LIST_TIMEOUT_MS = 20_000

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

const toProviderService = (s: ServiceObject): ProviderService => ({
    name: s.name,
    command: [s.cmd, ...(s.args ?? [])].join(' '),
    httpPort: s.http_port ?? null,
    status: s.state.status,
    pid: s.state.pid ?? null,
    startedAt: s.state.started_at ?? null,
    error: s.state.error ?? null
})

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

// The power sync lists every organisation every few seconds; a request log
// line per page of that would bury everything else.
const QUIET: SpritesLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
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

// sprites.dev can finish making a sprite after the request for it timed out
// or lost its connection. Seen on a local stack [2026-09-30]: the create
// timed out at 15 s, the rollback's delete found nothing, and the sprite
// came up afterwards, billing with nothing pointing at it. The name is the
// host's, so a sprite that shows up under it is the one asked for.
const LATE_CREATE_POLLS = 6
const LATE_CREATE_POLL_MS = 5_000

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

// running_limit / warm_limit are optional in the listing's envelope; an older
// or partial response records "unknown" (null) rather than a bogus 0, which
// would clamp the org cap to zero and block every wake.
const vendorLimit = (raw: unknown): number | null =>
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null

// sprites.dev reports "no activity recorded" as the zero time rather than
// omitting the field, and it is genuinely absent on some sprites — a session
// with no usable last_activity is aged from `created` instead.
const EXEC_SESSION_EPOCH_FLOOR_MS = Date.UTC(1971, 0, 1)

export interface AbandonedExecSession {
    session: ExecSessionInfo
    idleMs: number
    // Since it started; null without a usable start.
    ageMs: number | null
    // Idle past the window, or a TTY session older than it.
    reason: 'idle' | 'age'
}

// Read literally, year 1 would make every session look infinitely idle and
// reap live turns.
const usableStampMs = (raw: string | undefined): number | null => {
    const ms = raw ? Date.parse(raw) : Number.NaN
    return Number.isFinite(ms) && ms >= EXEC_SESSION_EPOCH_FLOOR_MS ? ms : null
}

// Last sign of life for an exec session.
const execSessionLastSeenMs = (session: ExecSessionInfo): number | null => {
    const stamps = [session.last_activity, session.created]
        .map(usableStampMs)
        .filter((ms): ms is number => ms !== null)
    return stamps.length > 0 ? Math.max(...stamps) : null
}

// Sessions sprites.dev still counts as active but that nothing has touched for
// longer than any legitimate exec. A session with no usable timestamp at all is
// deliberately left alone: with no age there is no evidence of abandonment, and
// killing a live turn is far worse than waiting for the next tick. A TTY
// session is also abandoned once it is older than the window, however recently
// it drew: nothing on the platform opens one any more (every terminal is a
// daemon pty), and a TUI left in one redraws often enough to look active
// forever.
// Seen on staging [2026-09-29]: a codex TUI the retired sprites terminal
// opened on 2026-09-09 still drew about 53 B/s, and its sandbox ran about
// 21 h a day.
export const abandonedExecSessions = (
    sessions: readonly ExecSessionInfo[],
    now: number,
    maxIdleMs: number
): AbandonedExecSession[] => {
    const out: AbandonedExecSession[] = []
    for (const session of sessions) {
        if (session.is_active !== true) continue
        const lastSeen = execSessionLastSeenMs(session)
        if (lastSeen === null) continue
        const idleMs = now - lastSeen
        const startedMs = usableStampMs(session.created)
        const ageMs = startedMs === null ? null : now - startedMs
        if (idleMs > maxIdleMs)
            out.push({ session, idleMs, ageMs, reason: 'idle' })
        else if (session.tty === true && ageMs !== null && ageMs > maxIdleMs)
            out.push({ session, idleMs, ageMs, reason: 'age' })
    }
    return out
}

// Only the argv head. The arguments carry user file paths — the leak that
// motivated the reaper was `cat > …/all_files 02.zip.mf-part` — while the
// binary name alone is what identifies which exec path leaked.
const execCommandHead = (command: string | undefined): string =>
    (command ?? '').trim().split(/\s+/)[0] || 'unknown'

interface SpritesVaultToken {
    orgSlug: string
    orgId: string
    tokenId: string
    fullToken: string
}

// A sprites.dev credential is `<orgSlug>/<orgId>/<tokenId>/<tokenValue>`; the
// three ids are the non-secret half and go into `config`, the whole string is
// the API token and goes into the envelope.
export const parseSpritesVaultToken = (raw: string): SpritesVaultToken => {
    const fullToken = raw.trim()
    const parts = fullToken.split('/')
    if (parts.length !== 4)
        throw new BadRequestException(
            'Sprites credential must be formatted "<orgSlug>/<orgId>/<tokenId>/<tokenValue>"'
        )
    const [orgSlug, orgId, tokenId, tokenValue] = parts
    if (!orgSlug || !orgId || !tokenId || !tokenValue)
        throw new BadRequestException('Sprites credential has an empty segment')
    return { orgSlug, orgId, tokenId, fullToken }
}

const optionalString = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

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

// The statuses sprites.dev's health check answers, in the host vocabulary.
// Anything else is `unknown`, which moves no host either way, rather than a
// guess at what an unseen literal means.
export const spriteHealthVerdict = (
    status: string | null | undefined
): SandboxHealthVerdict => {
    switch (status?.trim().toLowerCase()) {
        case 'healthy':
            return 'healthy'
        case 'unhealthy':
            return 'unhealthy'
        case 'needs_repair':
            return 'needs_repair'
        case 'repaired':
            return 'repaired'
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

    // The token's shape is all that is checked here; checkCredential calls
    // the API.
    async prepareCredential(
        credential: string,
        config: Record<string, unknown>
    ): Promise<PreparedCredential> {
        const parsed = parseSpritesVaultToken(credential)
        const spritesConfig: SpritesProviderConfig = {
            orgSlug: parsed.orgSlug,
            orgId: parsed.orgId,
            tokenId: parsed.tokenId,
            notes: optionalString(config.notes)
        }
        return {
            secret: parsed.fullToken,
            config: spritesConfig,
            health: { ok: true, message: 'credential accepted' }
        }
    }

    mergeConfig(
        current: RuntimeProviderConfig,
        patch: Record<string, unknown>
    ): RuntimeProviderConfig {
        const config = current as SpritesProviderConfig
        return {
            ...config,
            notes:
                patch.notes === undefined
                    ? (config.notes ?? null)
                    : optionalString(patch.notes)
        }
    }

    async checkCredential(provider: RuntimeProvider): Promise<CredentialHealth> {
        try {
            const sprites = await this.client({ provider }).listSprites()
            const n = sprites.sprites?.length ?? 0
            return {
                ok: true,
                message: `reachable (listed ${n} sprite${n === 1 ? '' : 's'})`
            }
        } catch (err) {
            return {
                ok: false,
                message: `api call failed: ${(err as Error).message.slice(0, 256)}`
            }
        }
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
        if (!sprite) sprite = await this.createSprite(client, spriteName)
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

    private async createSprite(
        client: SpritesClient,
        name: string
    ): Promise<Sprite> {
        try {
            return await client.createSprite({ name })
        } catch (err) {
            if (!(err instanceof SpritesError) || err.code !== 'transient')
                throw err
            for (let poll = 0; poll < LATE_CREATE_POLLS; poll++) {
                await this.delay(LATE_CREATE_POLL_MS)
                const late = await client.getSprite(name).catch(() => null)
                if (late) return late
            }
            throw err
        }
    }

    // Overridable in tests.
    protected delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }

    // A create that failed before it recorded the sprite may still have made
    // it: the name is the host's either way.
    async destroy(args: ProviderCall): Promise<void> {
        await assertCurrentGeneration(this.hosts, args.host, args.generation)
        const spriteName =
            this.ref(args)?.spriteName ?? spriteNameForHost(args.host.id)
        await this.client(args)
            .deleteSprite(spriteName)
            .catch((err) => {
                if (!isSpritesNotFound(err)) throw err
            })
    }

    async power(
        args: Omit<ProviderCall, 'generation'>
    ): Promise<ProviderPowerState> {
        const ref = this.ref(args)
        if (!ref) return 'unknown'
        try {
            const sprite = await this.client(args).getSprite(ref.spriteName)
            return spritePowerState(sprite.status)
        } catch (err) {
            if (isSpritesNotFound(err)) return 'gone'
            throw err
        }
    }

    // GET /sprites/{name}/check, by name: the id answers 404. It repairs what
    // it can as it checks, so the caller treats it as a wake.
    async checkHealth(
        args: Omit<ProviderCall, 'generation'>
    ): Promise<ProviderHealthReport | 'gone'> {
        const ref = this.ref(args)
        // Not made yet: there is no machine to ask about, which is not `gone`.
        if (!ref) throw new Error(`host ${args.host.id} has no sprite to check`)
        try {
            const check = await this.client(args).checkSprite(ref.spriteName)
            const rawStatus = String(check.status ?? '')
            return {
                verdict: spriteHealthVerdict(rawStatus),
                rawStatus,
                reason:
                    typeof check.reason === 'string' && check.reason !== ''
                        ? check.reason
                        : null,
                elapsedMs:
                    typeof check.elapsed === 'number' ? check.elapsed : null
            }
        } catch (err) {
            if (isSpritesNotFound(err)) return 'gone'
            throw err
        }
    }

    // One listing for the whole organisation. Usage is counted from the fully
    // paginated listing rather than the envelope's own running/warm/cold, which
    // describe only the page they came with; the limits are account-level.
    async observe(args: {
        provider: RuntimeProvider
        hosts: RuntimeHostRow[]
    }): Promise<ProviderObservation> {
        const list = await this.clients
            .spritesClientForProvider(args.provider, QUIET)
            .listSprites()
        if (!list) throw new Error('sprites listing answered nothing')
        const byName = new Map<string, RuntimeHostPowerState>()
        const counts = { running: 0, suspended: 0, stopped: 0 }
        for (const sprite of list.sprites) {
            const name = (sprite as { name?: unknown }).name
            if (typeof name !== 'string') continue
            const power = spritePowerState(sprite.status)
            byName.set(name, power)
            if (power === 'running') counts.running += 1
            else if (power === 'suspended') counts.suspended += 1
            else if (power === 'stopped') counts.stopped += 1
        }
        const power = new Map<string, RuntimeHostPowerState>()
        for (const host of args.hosts) {
            const listed = byName.get(this.ref({ host })?.spriteName ?? '')
            if (listed) power.set(host.id, listed)
        }
        return {
            power,
            capacity: {
                ...counts,
                runningLimit: vendorLimit(list.running_limit),
                suspendedLimit: vendorLimit(list.warm_limit)
            }
        }
    }

    // sprites.dev keeps a session's process alive after the client socket
    // goes away, so an exec that died without killing its session leaves the
    // process running — and a live exec session pins the VM `running`.
    async reapIdleSessions(
        args: Omit<ProviderCall, 'generation'>,
        opts: { maxIdleMs: number }
    ): Promise<ReapedSession[]> {
        const ref = this.ref(args)
        if (!ref) return []
        const client = this.client(args)
        let sessions: ExecSessionInfo[]
        try {
            sessions = await client.listExecSessions(ref.spriteName)
        } catch (err) {
            if (isSpritesNotFound(err)) return []
            throw err
        }
        const reaped: ReapedSession[] = []
        for (const { session, idleMs, ageMs, reason } of abandonedExecSessions(
            sessions,
            Date.now(),
            opts.maxIdleMs
        )) {
            await client.killExecSession(ref.spriteName, session.id)
            reaped.push({
                sessionId: session.id,
                command: execCommandHead(session.command),
                tty: session.tty === true,
                idleMs,
                ageMs,
                reason
            })
        }
        return reaped
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
            `sprite-env curl -s -X PUT "/v1/tasks/$MF_TASK_NAME" -d ${shellQuote(JSON.stringify({ expire: lease.ttl }))}`,
            lease.name
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

    // Confirmed the same way: by a listing without the name. An unreadable
    // listing is not a confirmation either way.
    async releaseAwake(
        args: Omit<ProviderCall, 'generation'>,
        lease: { name: string }
    ): Promise<void> {
        const listed = await this.listAfter(
            args,
            `sprite-env curl -s -X DELETE "/v1/tasks/$MF_TASK_NAME"`,
            lease.name
        )
        if (!listed)
            throw new Error(
                `sprite task listing unreadable after releasing ${lease.name}`
            )
        if (listed.some((task) => task.name === lease.name))
            throw new AwakeLeaseStillHeldError(lease.name)
    }

    // An unreadable listing is not an empty one: read as empty, the Tasks view
    // and a stop report nothing holding a sandbox that a task may be holding.
    async listAwake(
        args: Omit<ProviderCall, 'generation'>
    ): Promise<AwakeLease[]> {
        const exec = await this.clients.spriteExecForHost(
            args.host,
            this.spritesLogger()
        )
        const res = await exec({
            cmd: ['sprite-env', 'curl', '-s', '/v1/tasks'],
            timeoutMs: AWAKE_LIST_TIMEOUT_MS
        })
        const listed = parseTaskList(res.stdout)
        if (!listed)
            throw new Error(
                `sprite task listing unreadable (exit ${res.exitCode})`
            )
        return listed
    }

    // One exec: the task call, then the listing it is proven by (null when the
    // output is not a listing). The name may be an agent's, so it reaches the
    // shell URL-encoded through the env, never in the command line.
    private async listAfter(
        args: Omit<ProviderCall, 'generation'>,
        call: string,
        name: string
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
            env: { MF_TASK_NAME: encodeURIComponent(name) },
            timeoutMs: AWAKE_LEASE_TIMEOUT_MS
        })
        return parseTaskList(res.stdout)
    }

    // Measured on local [2026-09-28]: the listing answers a bare array, not
    // the { services } envelope its type names; both are read.
    async listServices(
        args: Omit<ProviderCall, 'generation'>
    ): Promise<ProviderService[]> {
        const ref = this.requireRef(args)
        const raw = (await this.client(args).listServices(
            ref.spriteName
        )) as unknown
        const list = Array.isArray(raw)
            ? (raw as ServiceObject[])
            : ((raw as ServiceListResponse).services ?? [])
        return list.map(toProviderService)
    }

    async removeService(
        args: Omit<ProviderCall, 'generation'>,
        name: string
    ): Promise<void> {
        const ref = this.requireRef(args)
        await this.client(args)
            .deleteService(ref.spriteName, name)
            .catch((err) => {
                if (!isSpritesNotFound(err)) throw err
            })
    }

    // The supervisor silently refuses to stop a service another one `needs`:
    // the state it answers with stays running.
    async stopService(
        args: Omit<ProviderCall, 'generation'>,
        name: string
    ): Promise<boolean> {
        const ref = this.requireRef(args)
        try {
            const after = await this.client(args).stopService(
                ref.spriteName,
                name
            )
            return after.state.status === 'stopped'
        } catch (err) {
            if (isSpritesNotFound(err)) return true
            throw err
        }
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
        route: { framework: string; port: number | null }
    ): Promise<void> {
        const ref = this.requireRef(args)
        const client = this.client(args)
        const port = route.port
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

    // A sprite this platform made is wide open (defaultNetworkPolicy); only one
    // whose policy denies everything by default needs the domains allowed.
    async allowEgress(
        args: Omit<ProviderCall, 'generation'>,
        domains: readonly string[]
    ): Promise<void> {
        const ref = this.requireRef(args)
        const client = this.client(args)
        const policy = await client.getNetworkPolicy(ref.spriteName)
        const rules = Array.isArray(policy.rules) ? policy.rules : []
        if (!rules.some((rule) => rule.domain === '*' && rule.action === 'deny'))
            return
        const missing = domains.filter(
            (domain) =>
                !rules.some(
                    (rule) => rule.domain === domain && rule.action === 'allow'
                )
        )
        if (missing.length === 0) return
        await client.setNetworkPolicy(ref.spriteName, {
            rules: [
                ...rules,
                ...missing.map((domain) => ({ domain, action: 'allow' as const }))
            ]
        })
        this.log.log(
            `sprite ${ref.spriteName} network policy opened to ${missing.join(', ')}`
        )
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
