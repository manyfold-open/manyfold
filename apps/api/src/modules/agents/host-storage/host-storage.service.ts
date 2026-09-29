import { Inject, Injectable } from '@nestjs/common'
import { inBackgroundContext } from '@/common/telemetry/background-context'
import { StorageMeasurementError } from '@/common/telemetry/storage-measurement-error'
import { and, asc, eq, ne, or, isNull, lte, sql } from 'drizzle-orm'
import { createObjectId } from '@manyfold/shared'
import { trace, SpanStatusCode } from '@opentelemetry/api'
import { suppressTracing } from '@sentry/opentelemetry'
import {
    agentRuntimes,
    agents,
    runtimeHosts,
    type Agent,
    type AgentStorageBreakdown,
    type Database,
    type RuntimeHostRow,
    type SandboxStorageBreakdown
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { HostDaemonAccess } from '@/modules/agents/adapters/host-daemon-access'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { shellQuote } from '@/modules/agents/workspace/workspace-preflight'
import {
    MeasurementObservation,
    storageFailureClass,
    STORAGE_PHASE_MARKER,
    MEASUREMENT_FORMAT_VERSION,
    type StorageMeasurementTrigger
} from './measurement-observation'
import { attributeStoragePaths } from './storage-attribution'
import { frameworkHome, workspacePathFor } from './agent-storage-paths'

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

// Whether a host's reading is old enough to take again, from the row alone:
// what a caller polling many hosts asks before it asks the service.
export const storageMeasurementDue = (
    host: Pick<RuntimeHostRow, 'storageMeasuredAt' | 'storageRetryAt'>,
    now = Date.now()
): boolean =>
    (!host.storageMeasuredAt ||
        now - host.storageMeasuredAt.getTime() >= MIN_INTERVAL_MS) &&
    (!host.storageRetryAt || host.storageRetryAt.getTime() <= now)

export interface MeasureTarget {
    host: RuntimeHostRow
    hostAgents: Agent[]
    homes: { framework: string; homeDir: string; agentIds?: string[] }[]
}

// A sandbox's storage, measured with df and du run by its daemon (ADR-0037
// R6). Only a provider that bills storage by use is metered: sprites.dev
// bills the whole persistent rootfs of each sprite.
@Injectable()
export class HostStorageService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly hostAccess: HostDaemonAccess,
        private readonly telemetry: TelemetryService
    ) {}

    async measureIfDue(
        agentId: string,
        trigger: StorageMeasurementTrigger = 'unspecified'
    ): Promise<void> {
        return this.background(trigger, async () => {
            const [row] = await this.db
                .select({ hostId: agentRuntimes.hostId })
                .from(agents)
                .innerJoin(agentRuntimes, eq(agentRuntimes.id, agents.runtimeId))
                .where(eq(agents.id, agentId))
                .limit(1)
            if (!row?.hostId) return
            await this.measureHostInScope(row.hostId, trigger)
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

    // A refresh the user asked for: measured now, inside the interval and past
    // a failed attempt's backoff, and on a sleeping VM too — any exec resumes
    // one, and the caller must already have admitted that wake. True once a
    // new reading is published, whether this call measured it or an attempt
    // already in flight did.
    async measureHostNow(hostId: string): Promise<boolean> {
        const reading = async () => {
            const [row] = await this.db
                .select({
                    measuredAt: runtimeHosts.storageMeasuredAt,
                    leased: sql<boolean>`coalesce(${runtimeHosts.storageLeaseUntil} > clock_timestamp(), false)`
                })
                .from(runtimeHosts)
                .where(eq(runtimeHosts.id, hostId))
                .limit(1)
            return row
        }
        const before = await reading()
        if (!before) return false
        // A live lease runs out within LEASE_MS; a holder that died with it
        // is outwaited by then.
        const deadline = Date.now() + LEASE_MS + 1000
        let row = before
        for (;;) {
            // The attempt holding the lease publishes a reading as new as
            // this one would be: wait for it rather than measure twice.
            if (!row.leased)
                await this.measureHostInScope(hostId, 'manual', true)
            else await new Promise((resolve) => setTimeout(resolve, 500))
            const next = await reading()
            if (!next) return false
            if (next.measuredAt?.getTime() !== before.measuredAt?.getTime())
                return true
            // Measured and nothing new, nothing in flight: it failed.
            if ((!row.leased && !next.leased) || Date.now() >= deadline)
                return false
            row = next
        }
    }

    private async measureHostInScope(
        hostId: string,
        trigger: StorageMeasurementTrigger,
        force = false
    ): Promise<void> {
        const [host] = await this.db
            .select()
            .from(runtimeHosts)
            .where(eq(runtimeHosts.id, hostId))
            .limit(1)
        if (!host) return
        if (host.kind !== 'hosted' || host.status !== 'ready') return
        if (host.providerRef?.kind !== 'sprites') return
        if (host.powerState !== 'running' && !force) return

        if (host.storageMeasuredAt && !force) {
            const sinceMs = Date.now() - host.storageMeasuredAt.getTime()
            if (sinceMs < MIN_INTERVAL_MS) return
        }

        // A measurement nobody asked for never wakes a sandbox, and never
        // brings its daemon up: it runs only on a machine already up with its
        // daemon connected. Any exec resumes a sleeping sprite, and a stretch
        // of running time the user did not start is billed to them.
        if (
            !force &&
            !(
                await this.hostAccess.ensure({
                    host,
                    daemon: null,
                    placement: 'sprites',
                    wake: false
                })
            ).online
        )
            return

        const attempt = new MeasurementObservation(
            createObjectId('storageMeasurementAttempt'),
            trigger
        )
        const due = force
            ? undefined
            : and(
                  eq(runtimeHosts.powerState, 'running'),
                  or(
                      isNull(runtimeHosts.storageMeasuredAt),
                      lte(
                          runtimeHosts.storageMeasuredAt,
                          sql`clock_timestamp() - ${MIN_INTERVAL_MS} * interval '1 millisecond'`
                      )
                  ),
                  or(
                      isNull(runtimeHosts.storageRetryAt),
                      lte(runtimeHosts.storageRetryAt, sql`clock_timestamp()`)
                  )
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
                        eq(runtimeHosts.kind, 'hosted'),
                        eq(runtimeHosts.status, 'ready'),
                        due,
                        or(
                            isNull(runtimeHosts.storageLeaseUntil),
                            lte(
                                runtimeHosts.storageLeaseUntil,
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
                .select({ agent: agents })
                .from(agents)
                .innerJoin(agentRuntimes, eq(agentRuntimes.id, agents.runtimeId))
                .where(
                    and(
                        eq(agentRuntimes.hostId, host.id),
                        ne(agents.status, 'failed')
                    )
                )
                .orderBy(asc(agents.id))
        ).then((rows) => rows.map((row) => row.agent))
        const homes = new Map<string, MeasureTarget['homes'][number]>()
        for (const agent of hostAgents) {
            const homeDir = frameworkHome(agent)?.path ?? null
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
            // A refresh the user asked for wakes the sandbox for it; the
            // automatic ones run only where it is already up (above).
            const result = await this.hostAccess.withHost(
                {
                    host,
                    daemon: null,
                    placement: 'sprites',
                    reason: 'storage',
                    wake: observation.trigger === 'manual'
                },
                (session) => {
                    observation.connected()
                    return session.exec({
                        cmd: ['bash', '-lc', buildMeasureScript(target)],
                        timeoutMs,
                        onStdout: (chunk) => observation.stdout(chunk)
                    })
                }
            )
            if (result.exitCode !== 0)
                throw new StorageMeasurementError('command')
            return parseMeasureOutput(target, result.stdout)
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
                    .where(eq(agents.id, agent.id))
            }
            return true
        })
    }
}

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
