import { randomUUID } from 'node:crypto'
import {
    Injectable,
    Logger,
    type OnModuleDestroy,
    type OnModuleInit
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { ChannelRow } from '@manyfold/db'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { ChannelBridgeService } from './channel-bridge.service'
import { ChannelProviderRegistry } from './channel-provider-registry.service'
import type { ChannelHandle } from './channel-provider'
import { ChannelsRepository } from './channels.repository'

const CHANNEL_SWEEP_INTERVAL_MS = 60_000
const LEASE_TTL_MS = 90_000
const LEASE_TICK_MS = 15_000
const STRANDED_ATTEMPTS_THRESHOLD = 10
const DELIVERY_RETENTION_DEFAULT_DAYS = 30
// The inbound dedup unique index only works while the original delivery row
// exists, so retention must comfortably outlive every provider's webhook
// redelivery horizon (Telegram retries up to ~24h).
const DELIVERY_RETENTION_MIN_DAYS = 7
const DELIVERY_PRUNE_BATCH_SIZE = 500
const DELIVERY_PRUNE_MAX_BATCHES = 4

// Status writes (applyStatus, markConnected/markError) bump updatedAt on
// every reconnect, so change detection must key on the config surface only
// or the owner would restart its own connection in a loop.
const channelFingerprint = (channel: ChannelRow): string =>
    JSON.stringify([
        channel.configJson,
        channel.credentialsCiphertext,
        channel.keyVersion
    ])

@Injectable()
export class ChannelManagerService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ChannelManagerService.name)
    private readonly handles = new Map<string, ChannelHandle>()
    private readonly fingerprints = new Map<string, string>()
    private sweepTimer: ReturnType<typeof setInterval> | null = null
    private leaseTimer: ReturnType<typeof setInterval> | null = null
    private ticking = false
    private readonly holderId: string
    private readonly enabled: boolean
    private readonly deliveryRetentionMs: number | null

    constructor(
        private readonly repo: ChannelsRepository,
        private readonly providers: ChannelProviderRegistry,
        private readonly bridge: ChannelBridgeService,
        private readonly telemetry: TelemetryService,
        config: ConfigService
    ) {
        this.enabled = config.get('CHANNELS_ENABLED') !== 'false'
        // Not HOSTNAME: two local dev processes would share it and both
        // believe they own every lease.
        this.holderId = config.get('FLY_MACHINE_ID') ?? randomUUID()
        this.deliveryRetentionMs = this.resolveDeliveryRetention(
            config.get('CHANNEL_DELIVERY_RETENTION_DAYS')
        )
    }

    private resolveDeliveryRetention(raw: unknown): number | null {
        if (raw === undefined || raw === null || raw === '')
            return DELIVERY_RETENTION_DEFAULT_DAYS * 24 * 60 * 60_000
        const days = Number(raw)
        if (!Number.isFinite(days)) {
            this.logger.warn(
                `invalid CHANNEL_DELIVERY_RETENTION_DAYS=${String(raw)}; using default ${DELIVERY_RETENTION_DEFAULT_DAYS}`
            )
            return DELIVERY_RETENTION_DEFAULT_DAYS * 24 * 60 * 60_000
        }
        if (days <= 0) {
            this.logger.log('channel delivery pruning disabled')
            return null
        }
        if (days < DELIVERY_RETENTION_MIN_DAYS) {
            this.logger.warn(
                `CHANNEL_DELIVERY_RETENTION_DAYS=${days} is below the ${DELIVERY_RETENTION_MIN_DAYS}-day dedup floor; clamping`
            )
            return DELIVERY_RETENTION_MIN_DAYS * 24 * 60 * 60_000
        }
        return days * 24 * 60 * 60_000
    }

    isEnabled(): boolean {
        return this.enabled
    }

    // The activity report clamps its window to this: counting over a window
    // longer than retention would label a partial count with the full span.
    // null means pruning is disabled, so no clamp applies.
    deliveryRetentionDays(): number | null {
        return this.deliveryRetentionMs === null
            ? null
            : Math.floor(this.deliveryRetentionMs / 86_400_000)
    }

    onModuleInit(): void {
        if (!this.enabled) {
            this.logger.log('channels disabled by CHANNELS_ENABLED=false')
            return
        }
        // Channel startup opens external connections (e.g. Lark long-connection
        // websocket) that can stall for seconds or hang outright. Awaiting it
        // here would block Nest bootstrap before app.listen(), so a single slow
        // provider takes the whole API down. Start in the background instead and
        // let per-channel status/retry surface failures.
        void this.bootstrapChannels().catch((err) => {
            this.logger.error(
                `channel bootstrap failed: ${(err as Error).message}`
            )
        })
        this.sweepTimer = setInterval(() => {
            void this.runSweep()
        }, CHANNEL_SWEEP_INTERVAL_MS)
        this.sweepTimer.unref?.()
        this.leaseTimer = setInterval(() => {
            void this.leaseTick().catch((err) => {
                this.logger.warn(
                    `lease tick failed: ${(err as Error).message}`
                )
            })
        }, LEASE_TICK_MS)
        this.leaseTimer.unref?.()
    }

    private async runSweep(): Promise<void> {
        await this.bridge.replayRecoverableInboundEvents().catch((err) => {
            this.logger.warn(
                `recoverable inbound replay failed: ${(err as Error).message}`
            )
        })
        // Reconcile before the outbound sweep so a reply recovered from
        // persisted turn state goes out on this tick, not the next one.
        await this.bridge.reconcilePendingReplies().catch((err) => {
            this.logger.warn(
                `pending reply reconcile failed: ${(err as Error).message}`
            )
        })
        await this.bridge.sweepOutboundDeliveries().catch((err) => {
            this.logger.warn(
                `outbound sweep failed: ${(err as Error).message}`
            )
        })
        await this.pruneDeliveries().catch((err) => {
            this.logger.warn(
                `delivery prune failed: ${(err as Error).message}`
            )
        })
    }

    private async pruneDeliveries(): Promise<void> {
        if (this.deliveryRetentionMs === null) return
        const cutoff = new Date(Date.now() - this.deliveryRetentionMs)
        let total = 0
        for (let i = 0; i < DELIVERY_PRUNE_MAX_BATCHES; i++) {
            const deleted = await this.repo.pruneDeliveries(
                cutoff,
                DELIVERY_PRUNE_BATCH_SIZE
            )
            total += deleted
            if (deleted < DELIVERY_PRUNE_BATCH_SIZE) break
        }
        if (total > 0)
            this.logger.log(
                `pruned ${total} channel deliver(ies) past retention`
            )
    }

    private async bootstrapChannels(): Promise<void> {
        await this.leaseTick()
        await this.bridge.replayRecoverableInboundEvents().catch((err) => {
            this.logger.warn(
                `recoverable inbound replay failed: ${(err as Error).message}`
            )
        })
    }

    private async leaseTick(): Promise<void> {
        if (this.ticking) return
        this.ticking = true
        try {
            const rows = await this.repo.listSchedulable()
            const byId = new Map(rows.map((row) => [row.id, row]))
            for (const id of [...this.handles.keys()]) {
                const row = byId.get(id)
                if (row && (row.status === 'active' || row.status === 'error'))
                    continue
                await this.stopChannel(id)
                await this.repo
                    .releaseChannelLease(id, this.holderId)
                    .catch((err) =>
                        this.logger.warn(
                            `failed to release lease channel=${id}: ${(err as Error).message}`
                        )
                    )
            }
            // One batched renewal for everything this instance already runs,
            // instead of one upsert per channel per tick. Channels missing
            // from the result lost their lease to another holder.
            const renewed = new Set(
                await this.repo.renewChannelLeases(
                    this.holderId,
                    [...this.handles.keys()],
                    LEASE_TTL_MS
                )
            )
            const now = new Date()
            for (const row of rows) {
                if (row.status !== 'active' && row.status !== 'error') continue
                // Webhook-style providers have nothing to run: their inbound
                // arrives over HTTP on any instance and their noop handles
                // would only waste a lease per channel per tick. A handle can
                // still exist here right after a config flip (e.g. lark
                // websocket -> webhook) on an instance that didn't serve the
                // update — tear it down.
                if (!this.managesConnection(row)) {
                    if (this.handles.has(row.id)) {
                        await this.stopChannel(row.id)
                        await this.repo
                            .releaseChannelLease(row.id, this.holderId)
                            .catch((err) =>
                                this.logger.warn(
                                    `failed to release lease channel=${row.id}: ${(err as Error).message}`
                                )
                            )
                    }
                    continue
                }
                const engaged = this.handles.has(row.id)
                // Errored channels stay schedulable: the DB-persisted backoff
                // (next_reconnect_at) is the only retry state, so recovery
                // survives restarts and lease failover.
                const reconnectDue =
                    row.status === 'error' &&
                    (row.nextReconnectAt === null ||
                        row.nextReconnectAt <= now)
                if (row.status === 'error' && !engaged && !reconnectDue)
                    continue
                let mine: boolean
                if (engaged) {
                    mine = renewed.has(row.id)
                } else {
                    try {
                        mine = await this.repo.tryAcquireChannelLease(
                            row.id,
                            this.holderId,
                            LEASE_TTL_MS
                        )
                    } catch (err) {
                        this.logger.warn(
                            `lease acquire failed channel=${row.id}: ${(err as Error).message}`
                        )
                        continue
                    }
                }
                if (!mine) {
                    if (engaged) await this.stopChannel(row.id)
                    continue
                }
                // Every reconnectDue path below performs a start, and a start
                // is not guaranteed to reach a terminal status within one tick
                // (a 'connecting' handle may need a full poll round trip), so
                // persist the next backoff window up front — otherwise the
                // tick would bounce such a handle every LEASE_TICK_MS forever.
                if (reconnectDue) await this.armReconnect(row)
                if (!engaged) {
                    await this.startChannel(row).catch((err) => {
                        this.logger.error(
                            `failed to start channel=${row.id}: ${(err as Error).message}`
                        )
                    })
                    continue
                }
                // reconnectDue with a live handle means in-handle recovery
                // (SDK auto-reconnect, matrix sync loop) missed its backoff
                // deadline, or the handle is a zombie whose async connect
                // failed after start() returned — bounce it.
                if (
                    reconnectDue ||
                    this.fingerprints.get(row.id) !== channelFingerprint(row)
                ) {
                    await this.stopChannel(row.id)
                    await this.startChannel(row).catch((err) => {
                        this.logger.error(
                            `failed to restart channel=${row.id}: ${(err as Error).message}`
                        )
                    })
                }
            }
        } finally {
            this.ticking = false
        }
    }

    async onModuleDestroy(): Promise<void> {
        if (this.sweepTimer) clearInterval(this.sweepTimer)
        this.sweepTimer = null
        if (this.leaseTimer) clearInterval(this.leaseTimer)
        this.leaseTimer = null
        for (const [id, handle] of this.handles)
            await handle.stop().catch((err) => {
                this.logger.warn(
                    `failed to stop channel=${id}: ${(err as Error).message}`
                )
            })
        this.handles.clear()
        this.fingerprints.clear()
        // Prompt release lets the next instance take over on its next tick
        // during rolling deploys instead of waiting out the lease TTL.
        await this.repo
            .releaseChannelLeasesByHolder(this.holderId)
            .catch((err) => {
                this.logger.warn(
                    `failed to release leases on shutdown: ${(err as Error).message}`
                )
            })
    }

    async reload(channel: ChannelRow): Promise<void> {
        if (!this.enabled) return
        await this.stopChannel(channel.id)
        if (channel.status !== 'active') return
        if (!this.managesConnection(channel)) return
        // Force-acquire keeps create/update/test synchronous on whichever
        // instance served the request; the displaced owner notices its lost
        // lease within one tick and stops its connection.
        await this.repo
            .forceAcquireChannelLease(channel.id, this.holderId, LEASE_TTL_MS)
            .catch((err) => {
                this.logger.warn(
                    `failed to force-acquire lease channel=${channel.id}: ${(err as Error).message}`
                )
            })
        await this.startChannel(channel)
    }

    async stopChannel(channelId: string): Promise<void> {
        this.fingerprints.delete(channelId)
        const handle = this.handles.get(channelId)
        if (!handle) return
        this.handles.delete(channelId)
        try {
            await handle.stop()
        } catch (err) {
            this.logger.warn(
                `failed to stop channel=${channelId}: ${(err as Error).message}`
            )
        }
    }

    async injectInbound(
        channel: ChannelRow,
        event: Parameters<ChannelBridgeService['handleInbound']>[1]
    ): Promise<void> {
        await this.bridge.handleInbound(channel, event)
    }

    handle(channelId: string): ChannelHandle | null {
        return this.handles.get(channelId) ?? null
    }

    private async startChannel(channel: ChannelRow): Promise<void> {
        let handle: ChannelHandle
        try {
            const provider = this.providers.get(channel.provider)
            const ctx = this.bridge.buildContext(channel)
            handle = await provider.start(
                ctx,
                async (event) => {
                    await this.bridge.handleInbound(channel, event)
                },
                (status, detail) => {
                    void this.applyStatus(channel.id, status, detail?.message)
                },
                async (action) => {
                    await this.bridge.handleInboundAction(channel, action)
                }
            )
        } catch (err) {
            // Persisting the failure sets next_reconnect_at, so the lease tick
            // retries this channel after the backoff — on whichever instance
            // holds the lease by then.
            await this.applyStatus(channel.id, 'error', (err as Error).message)
            throw err
        }
        this.handles.set(channel.id, handle)
        this.fingerprints.set(channel.id, channelFingerprint(channel))
        if (handle.status === 'connected')
            await this.applyStatus(channel.id, 'connected')
        this.logger.log(
            `started channel=${channel.id} provider=${channel.provider} status=${handle.status}`
        )
    }

    private async armReconnect(row: ChannelRow): Promise<void> {
        try {
            const attempts = await this.repo.armChannelReconnect(row.id)
            // null: the row left error status concurrently — nothing to arm.
            if (attempts === null) return
            this.logger.log(
                `reconnect attempt=${attempts} channel=${row.id} provider=${row.provider}`
            )
            this.maybeReportStranded(
                row.id,
                attempts,
                row.lastErrorMessage ?? 'unknown error'
            )
        } catch (err) {
            // Arm failure must not block the reconnect itself.
            this.logger.warn(
                `failed to arm reconnect channel=${row.id}: ${(err as Error).message}`
            )
        }
    }

    private managesConnection(row: ChannelRow): boolean {
        try {
            const provider = this.providers.get(row.provider)
            if (typeof provider.managesConnection !== 'function') return false
            return provider.managesConnection(
                provider.validateConfig(row.configJson)
            )
        } catch {
            return false
        }
    }

    private async applyStatus(
        channelId: string,
        status: 'connected' | 'connecting' | 'error',
        message?: string
    ): Promise<void> {
        try {
            if (status === 'connected') {
                await this.repo.markChannelConnected(channelId)
                return
            }
            if (status === 'error') {
                const attempts = await this.repo.markChannelError(
                    channelId,
                    message ?? 'unknown error'
                )
                this.maybeReportStranded(
                    channelId,
                    attempts,
                    message ?? 'unknown error'
                )
            }
        } catch (err) {
            this.logger.warn(
                `failed to update channel=${channelId} status: ${(err as Error).message}`
            )
        }
    }

    // Both increment sites (markChannelError, armChannelReconnect) bump by
    // exactly 1, so each attempt count is produced once and the equality check
    // still fires once per outage.
    private maybeReportStranded(
        channelId: string,
        attempts: number | null,
        errorMessage: string
    ): void {
        if (attempts !== STRANDED_ATTEMPTS_THRESHOLD) return
        this.logger.warn(
            `channel=${channelId} still down after ${attempts} reconnect attempts`
        )
        this.telemetry.event('channel.connection.stranded', {
            channelId,
            attempts,
            errorMessage
        })
    }
}
