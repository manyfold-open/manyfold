import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { inBackgroundContext } from '@/common/telemetry/background-context'
import { StorageMeasurementError } from '@/common/telemetry/storage-measurement-error'
import { and, asc, eq, ne, or, isNull, lte, sql } from 'drizzle-orm'
import { createObjectId, frameworkCapability } from '@manyfold/shared'
import { trace, SpanStatusCode } from '@opentelemetry/api'
import { suppressTracing } from '@sentry/opentelemetry'
import {
    agents,
    runtimeHosts,
    type Agent,
    type AgentStorageBreakdown,
    type Database,
    type RuntimeHostRow,
    type SandboxStorageBreakdown
} from '@manyfold/db'
import {
    createClient as createSpritesClient,
    execSpriteStream,
    type SpritesClient
} from '@manyfold/sprites'
import { DRIZZLE } from '@/db/tokens'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { SpriteExecHealthService } from '@/modules/agents/sprite-exec-health/sprite-exec-health.service'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { shellQuote } from '@/modules/agents/agent-diagnostics.service'
import {
    MeasurementObservation,
    storageFailureClass,
    STORAGE_PHASE_MARKER,
    MEASUREMENT_FORMAT_VERSION,
    type StorageMeasurementTrigger
} from './measurement-observation'
import { attributeStoragePaths } from './storage-attribution'

const MIN_INTERVAL_MS = 5 * 60 * 1000
const CMD_TIMEOUT_MS = 8_000
const DB_TIMEOUT_MS = 5_000
const LEASE_MS = 30_000
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 5 * 60 * 1000
const SECTION_SEP = '__NCA_STORAGE_SEP__'
// sprites.dev bills the whole persistent rootfs and gives the VM no separate
// volume, so the meter always reads `/`. Borrowing an agent's mountPath made
// an agent-less sandbox df a path nothing creates.
const DF_TARGET = '/'
type StorageTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export interface MeasureTarget {
    host: RuntimeHostRow
    hostAgents: Agent[]
    homes: { framework: string; homeDir: string; agentIds?: string[] }[]
}

@Injectable()
export class SpriteStorageService {
    private readonly log = new Logger(SpriteStorageService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly accounts: SpritesAccountsService,
        private readonly telemetry: TelemetryService,
        @Optional() private readonly execHealth?: SpriteExecHealthService
    ) {}

    async measureIfDue(
        agentId: string,
        trigger: StorageMeasurementTrigger = 'unspecified'
    ): Promise<void> {
        return this.background(trigger, async () => {
            const [agent] = await this.db
                .select()
                .from(agents)
                .where(eq(agents.id, agentId))
                .limit(1)
            if (!agent) return
            if (agent.runtime !== 'sprites') return
            if (!agent.hostId) return
            await this.measureHostInScope(agent.hostId, trigger)
        })
    }

    // Storage is measured (and metered) per sandbox VM: sprites.dev bills the
    // whole rootfs per sprite, so one df reading per host is the billable
    // figure. Per-agent workspace and per-framework home du readings ride along
    // as the drill-down.
    async measureHostIfDue(
        hostId: string,
        trigger: StorageMeasurementTrigger = 'unspecified'
    ): Promise<void> {
        return this.background(trigger, () =>
            this.measureHostInScope(hostId, trigger)
        )
    }

    private background(
        trigger: StorageMeasurementTrigger,
        work: () => Promise<void>
    ): Promise<void> {
        return inBackgroundContext(async () => {
            const started = performance.now()
            try {
                await work()
            } catch {
                trace
                    .getTracer('manyfold.storage')
                    .startActiveSpan('sprite.storage.measure', (span) => {
                        try {
                            const attrs = {
                                trigger,
                                phase: 'admission',
                                runtimeKind: 'sprites',
                                durationMs: Math.round(
                                    performance.now() - started
                                ),
                                failureClass: 'persistence',
                                outcome: 'failed'
                            }
                            span.setAttributes(attrs)
                            this.telemetry.error(
                                'sprite_storage_measure_failed',
                                new StorageMeasurementError('persistence'),
                                attrs
                            )
                        } finally {
                            span.end()
                        }
                    })
            }
        })()
    }

    private withDbBudget<T>(
        work: (tx: StorageTransaction) => Promise<T>
    ): Promise<T> {
        return this.db.transaction(async (tx) => {
            await tx.execute(
                sql`select set_config('statement_timeout', '5000', true), set_config('lock_timeout', '5000', true)`
            )
            return work(tx)
        })
    }

    private async measureHostInScope(
        hostId: string,
        trigger: StorageMeasurementTrigger
    ): Promise<void> {
        const [host] = await this.db
            .select()
            .from(runtimeHosts)
            .where(eq(runtimeHosts.id, hostId))
            .limit(1)
        if (!host) return
        if (host.kind !== 'sandbox') return
        if (!host.accountId || !host.spriteName) return
        const { accountId, spriteName } = host
        if (host.spriteStatus !== 'running') return

        if (host.storageMeasuredAt) {
            const sinceMs = Date.now() - host.storageMeasuredAt.getTime()
            if (sinceMs < MIN_INTERVAL_MS) return
        }

        // A VM already known to be refusing exec is not worth six 8s df/du
        // timeouts per request (#730 saw exactly that, from the prewarm and
        // message paths of three requests). Asked after the interval check, so
        // the common not-due call still costs one read.
        //
        // READ-ONLY on purpose: measurement never claims the fleet's one probe
        // lease and never clears a cooldown — spending the probe here would leave
        // the turn that follows with nothing to claim, and a df is not the
        // idempotent no-op that proves recovery. The interval bookkeeping is
        // untouched, so the next due window measures normally once the host is
        // back (#553 / #575 / #580 semantics unchanged).
        if (await this.execHealth?.isKnownUnavailable(host.id)) {
            this.log.debug(
                'storage measurement skipped: exec endpoint unhealthy'
            )
            return
        }

        const attempt = new MeasurementObservation(
            createObjectId('storageMeasurementAttempt'),
            trigger
        )
        const [claimed] = await this.withDbBudget(async (tx) =>
            tx
                .update(runtimeHosts)
                .set({
                    storageAttemptId: attempt.id,
                    storageLeaseUntil: sql`clock_timestamp() + ${LEASE_MS} * interval '1 millisecond'`
                })
                .where(
                    and(
                        eq(runtimeHosts.id, host.id),
                        eq(runtimeHosts.kind, 'sandbox'),
                        eq(runtimeHosts.status, 'active'),
                        eq(runtimeHosts.spriteStatus, 'running'),
                        eq(runtimeHosts.accountId, accountId),
                        eq(runtimeHosts.spriteName, spriteName),
                        or(
                            isNull(runtimeHosts.storageMeasuredAt),
                            lte(
                                runtimeHosts.storageMeasuredAt,
                                sql`clock_timestamp() - ${MIN_INTERVAL_MS} * interval '1 millisecond'`
                            )
                        ),
                        or(
                            isNull(runtimeHosts.storageLeaseUntil),
                            lte(
                                runtimeHosts.storageLeaseUntil,
                                sql`clock_timestamp()`
                            )
                        ),
                        or(
                            isNull(runtimeHosts.storageRetryAt),
                            lte(
                                runtimeHosts.storageRetryAt,
                                sql`clock_timestamp()`
                            )
                        )
                    )
                )
                .returning()
        )
        if (!claimed) return
        return trace
            .getTracer('manyfold.storage')
            .startActiveSpan('sprite.storage.measure', async (span) => {
                let outcome: 'success' | 'failed' | 'superseded' = 'failed'
                span.setAttributes({
                    holderId: attempt.id,
                    trigger,
                    runtimeKind: 'sprites'
                })
                try {
                    try {
                        const target = await this.targetFor(claimed)
                        const breakdown = await this.measureNow(target, attempt)
                        // 'stale' means neither df nor any du produced a reading. Persisting
                        // it would publish a fabricated 0 into the storage meter and quota
                        // check over whatever the host really holds, so it takes the same
                        // path as a thrown measurement error and the previous reading stays.
                        if (breakdown.measuredVia === 'stale')
                            throw new StorageMeasurementError('unreadable')
                        attempt.phase = 'persist'
                        if (
                            !(await this.persist(target, breakdown, attempt.id))
                        ) {
                            outcome = 'superseded'
                            return
                        }
                        outcome = 'success'
                        this.telemetry.event('sprite_storage_measured', {
                            holderId: attempt.id,
                            trigger: attempt.trigger,
                            runtimeKind: 'sprites',
                            phase: attempt.phase,
                            timeoutMs: attempt.execTimeoutMs,
                            durationMs: Math.round(
                                performance.now() - attempt.startedAt
                            ),
                            vmUsedBytes: breakdown.vmUsedBytes,
                            workspaceBytes: sumBytes(breakdown.workspaces),
                            homeBytes: sumBytes(breakdown.homes),
                            agentCount: target.hostAgents.length,
                            measuredVia: breakdown.measuredVia
                        })
                    } catch (err) {
                        const [failed] = await this.withDbBudget(async (tx) =>
                            tx
                                .update(runtimeHosts)
                                .set({
                                    storageAttemptId: null,
                                    storageLeaseUntil: null,
                                    storageRetryAt: sql`clock_timestamp() + least(${RETRY_MAX_MS}, ${RETRY_BASE_MS} * power(2, least(${runtimeHosts.storageFailureCount}, 4))) * interval '1 millisecond'`,
                                    storageFailureCount: sql`${runtimeHosts.storageFailureCount} + 1`
                                })
                                .where(
                                    and(
                                        eq(runtimeHosts.id, host.id),
                                        eq(
                                            runtimeHosts.storageAttemptId,
                                            attempt.id
                                        )
                                    )
                                )
                                .returning({
                                    failures: runtimeHosts.storageFailureCount
                                })
                        )
                        if (!failed) {
                            outcome = 'superseded'
                            return
                        }
                        const failureClass = storageFailureClass(
                            err,
                            attempt.phase
                        )
                        const attrs = {
                            holderId: attempt.id,
                            trigger: attempt.trigger,
                            runtimeKind: 'sprites',
                            phase: attempt.phase,
                            timeoutMs:
                                attempt.phase === 'persist'
                                    ? DB_TIMEOUT_MS
                                    : attempt.execTimeoutMs,
                            durationMs: Math.round(
                                performance.now() - attempt.startedAt
                            ),
                            attempts: failed.failures,
                            failureClass,
                            outcome
                        }
                        if (Number.isInteger(Math.log2(failed.failures)))
                            this.telemetry.error(
                                'sprite_storage_measure_failed',
                                new StorageMeasurementError(failureClass),
                                attrs
                            )
                        else
                            this.telemetry.event(
                                'sprite_storage_measure_failed',
                                attrs
                            )
                    }
                } finally {
                    for (const [phase, timing] of attempt.timings)
                        this.telemetry.event('sprite_storage_phase', {
                            holderId: attempt.id,
                            trigger,
                            runtimeKind: 'sprites',
                            phase,
                            timeoutMs: attempt.execTimeoutMs,
                            durationMs: Math.round(timing.durationMs),
                            count: timing.count,
                            outcome
                        })
                    if (outcome === 'failed')
                        span.setStatus({ code: SpanStatusCode.ERROR })
                    span.end()
                }
            })
    }

    private async targetFor(host: RuntimeHostRow): Promise<MeasureTarget> {
        const hostAgents = await this.withDbBudget(async (tx) =>
            tx
                .select()
                .from(agents)
                .where(
                    and(
                        eq(agents.hostId, host.id),
                        eq(agents.runtime, 'sprites'),
                        ne(agents.status, 'failed')
                    )
                )
                .orderBy(asc(agents.id))
        )
        const homes = new Map<string, MeasureTarget['homes'][number]>()
        for (const agent of hostAgents) {
            const homeDir = frameworkHomeDir(agent)
            if (!homeDir) continue
            const key = JSON.stringify([agent.framework, homeDir])
            const existing = homes.get(key)
            if (existing) existing.agentIds!.push(agent.id)
            else
                homes.set(key, {
                    framework: agent.framework,
                    homeDir,
                    agentIds: [agent.id]
                })
        }
        return {
            host,
            hostAgents,
            homes: [...homes.values()]
        }
    }

    private async measureNow(
        target: MeasureTarget,
        observation: MeasurementObservation
    ): Promise<SandboxStorageBreakdown> {
        const { host } = target
        const client = await this.clientFor(host)
        const [lease] = await this.withDbBudget(async (tx) =>
            tx
                .select({
                    remaining: sql<number>`extract(epoch from (${runtimeHosts.storageLeaseUntil} - clock_timestamp())) * 1000`
                })
                .from(runtimeHosts)
                .where(
                    and(
                        eq(runtimeHosts.id, host.id),
                        eq(runtimeHosts.storageAttemptId, observation.id),
                        sql`${runtimeHosts.storageLeaseUntil} > clock_timestamp()`
                    )
                )
                .limit(1)
        )
        if (!lease) throw new StorageMeasurementError('unknown')
        const timeoutMs = Math.max(
            1,
            Math.min(CMD_TIMEOUT_MS, Math.floor(Number(lease.remaining)))
        )
        observation.startExec(timeoutMs)
        trace.getActiveSpan()?.setAttribute('timeoutMs', timeoutMs)
        return suppressTracing(async () => {
            const stream = execSpriteStream(
                client,
                host.spriteName as string,
                {
                    cmd: ['bash', '-lc', buildMeasureScript(target)],
                    stdin: '',
                    timeoutMs,
                    onSessionId: () => observation.sessionOpened()
                },
                observation.logger
            )
            const outcome = stream.result.then(
                (result) => ({ result }),
                (error) => ({ error })
            )
            const stderr = (async () => {
                for await (const chunk of stream.stderr) void chunk
            })().catch(() => undefined)
            try {
                for await (const chunk of stream.stdout)
                    observation.stdout(chunk)
                const settled = await outcome
                if ('error' in settled) throw settled.error
                if (settled.result.exitCode !== 0)
                    throw new StorageMeasurementError('command')
                return parseMeasureOutput(target, settled.result.stdout)
            } finally {
                await stderr
            }
        })
    }

    protected async clientFor(host: RuntimeHostRow): Promise<SpritesClient> {
        const account = await this.accounts.getById(host.accountId as string)
        if (!account) throw new StorageMeasurementError('permission')
        return createSpritesClient({
            token: this.accounts.decryptToken(account),
            accountSlug: account.slug
        })
    }

    private async persist(
        target: MeasureTarget,
        breakdown: SandboxStorageBreakdown,
        attemptId: string
    ): Promise<boolean> {
        const now = new Date()
        const hostBytes = breakdown.vmUsedBytes
        return this.withDbBudget(async (tx) => {
            const updated = await tx
                .update(runtimeHosts)
                .set({
                    storageBytes: hostBytes,
                    storageMeasuredAt: sql`clock_timestamp()`,
                    storageBreakdown: {
                        ...breakdown,
                        formatVersion: MEASUREMENT_FORMAT_VERSION
                    },
                    storageAttemptId: null,
                    storageLeaseUntil: null,
                    storageRetryAt: null,
                    storageFailureCount: 0,
                    updatedAt: now
                })
                .where(
                    and(
                        eq(runtimeHosts.id, target.host.id),
                        eq(runtimeHosts.storageAttemptId, attemptId),
                        sql`${runtimeHosts.storageLeaseUntil} > clock_timestamp()`
                    )
                )
                .returning({ measuredAt: runtimeHosts.storageMeasuredAt })
            if (updated.length !== 1) return false
            const workspaceByAgent = new Map(
                breakdown.workspaces.map((w) => [w.agentId, w.bytes])
            )
            for (const agent of target.hostAgents) {
                const workspaceBytes = workspaceByAgent.get(agent.id)
                // No entry means this agent's du produced nothing; leave its
                // previous reading alone rather than overwrite it with a 0.
                if (workspaceBytes === undefined) continue
                const home = breakdown.homes.find((item) =>
                    item.agentIds
                        ? item.agentIds.includes(agent.id)
                        : item.framework === agent.framework
                )
                const homeRequested = target.homes.some((item) =>
                    item.agentIds
                        ? item.agentIds.includes(agent.id)
                        : item.framework === agent.framework
                )
                const homeBytes = home
                    ? home.attributedBytes === undefined
                        ? home.bytes
                        : home.attributedBytes
                    : homeRequested
                      ? null
                      : 0
                const agentBreakdown: AgentStorageBreakdown = {
                    formatVersion: MEASUREMENT_FORMAT_VERSION,
                    workspaceBytes,
                    homeBytes,
                    totalBytes:
                        homeBytes === null ? null : workspaceBytes + homeBytes,
                    measuredVia: breakdown.measuredVia
                }
                await tx
                    .update(agents)
                    .set({
                        storageBytes: workspaceBytes,
                        storageMeasuredAt: updated[0].measuredAt,
                        storageBreakdown: agentBreakdown,
                        updatedAt: now
                    })
                    .where(
                        and(
                            eq(agents.id, agent.id),
                            eq(agents.hostId, target.host.id)
                        )
                    )
            }
            return true
        })
    }
}

const frameworkHomeDir = (agent: Agent): string | null => {
    if (agent.framework === 'openclaw' || agent.framework === 'hermes')
        return agent.mountPath || null
    const config = frameworkCapability(agent.framework).configHome
    if (!config) return null
    return (
        agent.fileRoots?.find((root) => root.id === config.rootId)?.path ??
        `~/${config.subdir}`
    )
}

const workspacePathFor = (agent: Agent): string =>
    agent.workspacePath || agent.mountPath || '/workspace'

// Section order is the parse contract: df, then one du per agent workspace
// (hostAgents order), then one du per framework home (homes order).
//
// An empty section is the failure signal. Each section ends in awk, which exits
// 0 on empty input, so a failed df/du can never be detected from an exit status
// or coaxed into printing a fallback value — it just yields no line.
// parseMeasureOutput therefore treats a section with no number as unmeasured,
// never as a measured 0.
export const buildMeasureScript = (target: MeasureTarget): string => {
    const sections = [
        {
            phase: 'df',
            path: null,
            cmd: `if nca_storage_output=$(df -B1 ${DF_TARGET} 2>/dev/null); then printf '%s\\n' "$nca_storage_output" | tail -n1 | awk '{print $(NF-3)}'; fi`
        },
        ...target.hostAgents.map((agent) => ({
            phase: 'workspace_du',
            path: workspacePathFor(agent),
            cmd: ''
        })),
        ...target.homes.map((home) => ({
            phase: 'home_du',
            path: home.homeDir,
            cmd: ''
        }))
    ]
    return [
        'set +e',
        ...sections.flatMap(({ cmd, phase, path }, i) => {
            const targetPath = path?.startsWith('~/')
                ? `"$HOME"/${shellQuote(path.slice(2))}`
                : shellQuote(path ?? '')
            return [
                ...(i ? [`echo ${SECTION_SEP}`] : []),
                `printf '${STORAGE_PHASE_MARKER} ${phase} start %s\\n' "\${EPOCHREALTIME//./}"`,
                ...(path
                    ? [
                          `nca_storage_path=${targetPath}`,
                          'nca_storage_resolved=',
                          'if [ ! -L "$nca_storage_path" ]; then IFS= read -r -d "" nca_storage_resolved < <(realpath -ze -- "$nca_storage_path" 2>/dev/null); fi',
                          `printf '\\0__NCA_STORAGE_PATH__\\0%s\\0%s\\0' '${i}' "$nca_storage_resolved"`,
                          'if nca_storage_output=$(du -sb -- "$nca_storage_path" 2>/dev/null); then nca_storage_bytes=${nca_storage_output%%[[:space:]]*}; if [[ "$nca_storage_bytes" =~ ^[0-9]+$ ]]; then printf "%s\\n" "$nca_storage_bytes"; fi; fi'
                      ]
                    : [cmd]),
                `printf '${STORAGE_PHASE_MARKER} ${phase} end %s\\n' "\${EPOCHREALTIME//./}"`
            ]
        })
    ].join('\n')
}

export const parseMeasureOutput = (
    target: Pick<MeasureTarget, 'hostAgents' | 'homes'>,
    stdout: string
): SandboxStorageBreakdown => {
    const resolved = new Map<number, string>()
    const clean = stdout.replace(
        /\0__NCA_STORAGE_PATH__\0(\d+)\0([^\0]*)\0/g,
        (_, index: string, path: string) => {
            resolved.set(Number(index), path)
            return ''
        }
    )
    const parts = clean.split(SECTION_SEP).map((s) => s.trim())
    const dfBytes = parseFirstNumber(parts[0])
    const workspaceReadings = target.hostAgents.map((agent, i) => ({
        key: `0:workspace:${agent.id}`,
        path: resolved.get(1 + i) ?? '',
        bytes: parseFirstNumber(parts[1 + i])
    }))
    const homeReadings = target.homes.map((home, i) => ({
        key: `1:home:${home.framework}:${home.homeDir}`,
        path: resolved.get(1 + target.hostAgents.length + i) ?? '',
        bytes: parseFirstNumber(parts[1 + target.hostAgents.length + i])
    }))
    const attribution = attributeStoragePaths(
        [...workspaceReadings, ...homeReadings],
        null
    )
    const workspaces = target.hostAgents.flatMap((agent, i) => {
        const bytes = parseFirstNumber(parts[1 + i])
        return bytes === null
            ? []
            : [
                  {
                      agentId: agent.id,
                      bytes,
                      attributedBytes:
                          attribution.attributed.get(
                              workspaceReadings[i].key
                          ) ?? null
                  }
              ]
    })
    const homes = target.homes.flatMap((home, i) => {
        const bytes = parseFirstNumber(parts[1 + target.hostAgents.length + i])
        return bytes === null
            ? []
            : [
                  {
                      framework: home.framework,
                      bytes,
                      path:
                          resolved.get(1 + target.hostAgents.length + i) ||
                          home.homeDir,
                      agentIds: home.agentIds,
                      attributedBytes:
                          attribution.attributed.get(homeReadings[i].key) ??
                          null
                  }
              ]
    })
    if (dfBytes !== null && dfBytes > 0)
        return {
            vmUsedBytes: dfBytes,
            homes,
            workspaces,
            measuredVia: 'df',
            attributionComplete: attribution.complete
        }
    const duTotal = attribution.unionBytes
    if (duTotal !== null && duTotal > 0)
        return {
            vmUsedBytes: duTotal,
            homes,
            workspaces,
            measuredVia: 'du',
            attributionComplete: attribution.complete
        }
    // Neither an authoritative df nor a consistent known-path union is
    // available. The caller preserves the old meter instead of publishing 0.
    return { vmUsedBytes: 0, homes, workspaces, measuredVia: 'stale' }
}

const sumBytes = (items: { bytes: number }[]): number =>
    items.reduce((total, item) => total + item.bytes, 0)

const parseFirstNumber = (value: string | undefined): number | null => {
    if (!value) return null
    const match = value.trim().match(/^(\d+)/m)
    if (!match) return null
    const n = Number(match[1])
    return Number.isFinite(n) ? n : null
}
