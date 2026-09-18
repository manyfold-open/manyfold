import {
    Inject,
    Injectable,
    OnModuleDestroy,
    OnModuleInit
} from '@nestjs/common'
import { and, asc, eq, gt, ne } from 'drizzle-orm'
import { agents, type Database } from '@manyfold/db'
import { frameworkMcpSupport } from '@manyfold/shared'
import { trace } from '@opentelemetry/api'
import { DRIZZLE } from '@/db/tokens'
import { inBackgroundContext } from '@/common/telemetry/background-context'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import {
    DaemonRegistryService,
    type DaemonHelloEvidence
} from '@/modules/daemon/daemon-registry.service'
import {
    DaemonConfigDeliveryError,
    DAEMON_CONFIG_LEASE_MS
} from '@/modules/daemon/daemon-config-delivery.service'
import { McpConfigMaterializer } from '@/modules/agent-runtimes/mcp/mcp-config-materializer.service'
import { contextDocInstructionFile } from '@/modules/agent-self/agent-context-doc.service'
import { AgentContextDocManageService } from './agent-context-doc-manage.service'

interface ReconcileState {
    userId: string
    evidence: DaemonHelloEvidence
    timer?: NodeJS.Timeout
    running?: Promise<void>
    abort?: AbortController
    changed: boolean
    attempts: number
    nextAt: number
    cursor?: string
    retryPending?: boolean
    leaseBlocked?: boolean
}
@Injectable()
export class DaemonConfigReconciler implements OnModuleInit, OnModuleDestroy {
    private readonly states = new Map<string, ReconcileState>()
    private stopHello?: () => void
    private stopRetirement?: () => void
    private stopped = false
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly registry: DaemonRegistryService,
        private readonly mcp: McpConfigMaterializer,
        private readonly context: AgentContextDocManageService,
        private readonly telemetry: TelemetryService
    ) {}

    onModuleInit(): void {
        this.stopHello = this.registry.onHelloAccepted(
            (daemonId, userId, evidence) => {
                if (this.stopped) return
                const state = this.states.get(daemonId) ?? {
                    userId,
                    evidence,
                    changed: false,
                    attempts: 0,
                    nextAt: 0
                }
                state.userId = userId
                state.evidence = evidence
                state.changed = true
                if (!state.running) {
                    state.cursor = undefined
                    state.attempts = 0
                    state.retryPending = false
                    state.leaseBlocked = false
                }
                this.states.set(daemonId, state)
                this.schedule(daemonId, state)
            }
        )
        this.stopRetirement = this.registry.onConnectionRetired((id, token) => {
            const state = this.states.get(id)
            if (!state || state.evidence.connectionToken !== token) return
            if (state.timer) clearTimeout(state.timer)
            state.abort?.abort()
            this.states.delete(id)
        })
    }

    async onModuleDestroy(): Promise<void> {
        this.stopped = true
        this.stopHello?.()
        this.stopRetirement?.()
        const running: Promise<void>[] = []
        for (const state of this.states.values()) {
            if (state.timer) clearTimeout(state.timer)
            state.abort?.abort()
            if (state.running) running.push(state.running)
        }
        this.states.clear()
        await Promise.allSettled(running)
    }

    private schedule(daemonId: string, state: ReconcileState): void {
        if (state.running || state.timer || this.stopped) return
        state.timer = setTimeout(
            () => {
                state.timer = undefined
                if (this.states.get(daemonId) !== state || this.stopped) return
                state.abort = new AbortController()
                state.running = inBackgroundContext(() =>
                    this.run(daemonId, state)
                )().finally(() => {
                    state.running = undefined
                    state.abort = undefined
                    if (state.changed && this.states.get(daemonId) === state)
                        this.schedule(daemonId, state)
                })
            },
            Math.max(0, state.nextAt - Date.now())
        )
        state.timer.unref()
    }

    private async run(daemonId: string, state: ReconcileState): Promise<void> {
        const evidence = state.evidence
        state.changed = false
        state.nextAt = Date.now() + 2000
        let retry = false
        let continuation = false
        let count = 0
        let cancelled = false
        let unsupported = false
        const started = performance.now()
        await trace
            .getTracer('manyfold.daemon-config')
            .startActiveSpan('daemon.config.reconcile', async (span) => {
                try {
                    if (
                        !this.registry.isCurrentHelloEvidence(
                            daemonId,
                            evidence
                        )
                    ) {
                        cancelled = true
                        return
                    }
                    const rows = await this.db
                        .select()
                        .from(agents)
                        .where(
                            and(
                                eq(agents.daemonId, daemonId),
                                eq(agents.userId, state.userId),
                                eq(agents.runtime, 'daemon'),
                                ne(agents.status, 'failed'),
                                state.cursor
                                    ? gt(agents.id, state.cursor)
                                    : undefined
                            )
                        )
                        .orderBy(asc(agents.id))
                        .limit(100)
                    for (const agent of rows) {
                        if (
                            this.stopped ||
                            !this.registry.isCurrentHelloEvidence(
                                daemonId,
                                evidence
                            )
                        ) {
                            cancelled = true
                            break
                        }
                        if (performance.now() - started >= 90_000) {
                            continuation = true
                            break
                        }
                        const options = {
                            automatic: true,
                            evidence,
                            signal: state.abort?.signal
                        }
                        try {
                            if (frameworkMcpSupport(agent.framework)) {
                                const results =
                                    await this.mcp.materializeForAgent(
                                        agent,
                                        options
                                    )
                                if (
                                    results.some(
                                        (result) => result.status === 'failed'
                                    )
                                )
                                    retry = true
                            }
                            if (contextDocInstructionFile(agent.framework))
                                await this.context.refreshDaemon(agent, options)
                            count++
                        } catch (error) {
                            if (state.abort?.signal.aborted) cancelled = true
                            if (
                                error instanceof DaemonConfigDeliveryError &&
                                error.reason === 'busy'
                            )
                                state.leaseBlocked = true
                            if (
                                error instanceof DaemonConfigDeliveryError &&
                                error.reason === 'unsupported'
                            )
                                unsupported = true
                            if (
                                !(error instanceof DaemonConfigDeliveryError) ||
                                ![
                                    'unsupported',
                                    'superseded',
                                    'cancelled'
                                ].includes(error.reason)
                            )
                                retry = true
                        }
                        state.cursor = agent.id
                    }
                    if (rows.length === 100) continuation = true
                } catch {
                    retry = true
                } finally {
                    const outcome = cancelled
                        ? 'cancelled'
                        : continuation || state.changed
                          ? 'deferred'
                          : retry || state.retryPending
                            ? 'failed'
                            : unsupported
                              ? 'unsupported'
                              : 'complete'
                    this.telemetry.event('daemon_config_reconcile', {
                        outcome,
                        count,
                        attempts: state.attempts + 1,
                        durationMs: Math.round(performance.now() - started)
                    })
                    span.setAttributes({ outcome, count })
                    span.end()
                }
            })
        state.retryPending ||= retry
        if (state.evidence !== evidence) {
            state.cursor = undefined
            state.changed = true
            state.retryPending = false
            state.leaseBlocked = false
            state.attempts = 0
        } else if (continuation) state.changed = true
        else if (state.retryPending && ++state.attempts < 3) {
            state.changed = true
            state.cursor = undefined
            state.retryPending = false
            // A crashed owner can outlive both short retries. Keep one attempt
            // after its lease can expire, without starting an endless poller.
            state.nextAt =
                Date.now() +
                (state.attempts === 2 && state.leaseBlocked
                    ? DAEMON_CONFIG_LEASE_MS
                    : 5000 * state.attempts)
        }
    }
}
