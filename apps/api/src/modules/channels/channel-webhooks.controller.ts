import type { ChannelProviderName } from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    Controller,
    Headers,
    HttpCode,
    Logger,
    NotFoundException,
    Param,
    Post,
    Req,
    UnauthorizedException
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { ChannelsService } from './channels.service'
import { ChannelManagerService } from './channel-manager.service'
import {
    ChannelBridgeService,
    normalizeProviderEventId
} from './channel-bridge.service'
import { ChannelProviderRegistry } from './channel-provider-registry.service'
import { ChannelsRepository } from './channels.repository'
import { UnsupportedEventError } from './channel-provider'

const SUMMARY_MAX_LEN = 200
// Signature failures are unauthenticated writes: without a floor, a
// misconfigured provider retry loop (or anyone holding a channel id) inserts
// a delivery row per request. One recorded row per channel per window keeps
// the evidence without the amplification; telemetry still fires per event.
const SIGNATURE_FAILURE_RECORD_WINDOW_MS = 5 * 60_000

@Controller('channels/hooks')
export class ChannelWebhooksController {
    private readonly logger = new Logger(ChannelWebhooksController.name)
    // Keyed by verified-to-exist channel ids, so bounded by real channel count.
    private readonly signatureFailureRecordedAt = new Map<string, number>()

    constructor(
        private readonly channels: ChannelsService,
        private readonly manager: ChannelManagerService,
        private readonly bridge: ChannelBridgeService,
        private readonly providers: ChannelProviderRegistry,
        private readonly repo: ChannelsRepository,
        private readonly telemetry: TelemetryService
    ) {}

    @Post(':provider/:channelId')
    @HttpCode(200)
    async receive(
        @Param('provider') providerName: ChannelProviderName,
        @Param('channelId') channelId: string,
        @Headers() headers: Record<string, string>,
        @Body() body: unknown,
        @Req() req: FastifyRequest
    ): Promise<unknown> {
        if (!this.manager.isEnabled())
            throw new NotFoundException('channels feature is disabled')
        const channel = await this.repo.getById(channelId)
        if (!channel) throw new NotFoundException('channel not found')
        if (channel.provider !== providerName)
            throw new BadRequestException('provider mismatch')
        const provider = this.providers.get(providerName)
        const ctx = this.bridge.buildContext(channel)
        const rawBody = (req as unknown as { rawBody?: string } | undefined)
            ?.rawBody
        const sig = provider.verifySignature({ headers, body, rawBody }, ctx)
        if (!sig.ok) {
            const lastRecorded =
                this.signatureFailureRecordedAt.get(channel.id) ?? 0
            if (Date.now() - lastRecorded > SIGNATURE_FAILURE_RECORD_WINDOW_MS) {
                this.signatureFailureRecordedAt.set(channel.id, Date.now())
                await this.repo.insertDelivery({
                    channelId: channel.id,
                    chatSessionId: null,
                    chatMessageId: null,
                    direction: 'inbound',
                    scopeKey: 'unknown',
                    providerEventId: null,
                    providerMessageId: null,
                    summaryText: null,
                    status: 'dropped',
                    errorMessage: sig.reason ?? 'signature_mismatch',
                    createdAt: new Date()
                })
            }
            this.telemetry.event('channel.inbound.rejected', {
                channelId: channel.id,
                reason: sig.reason ?? 'signature_mismatch'
            })
            throw new UnauthorizedException(sig.reason ?? 'signature_mismatch')
        }
        if (sig.challengeResponse) {
            if (channel.status !== 'draft' && channel.status !== 'active')
                throw new BadRequestException(`channel is ${channel.status}`)
            if (channel.status === 'draft')
                await this.channels.markConnected(channel.id).catch(() => {})
            return sig.challengeResponse.body
        }
        if (channel.status !== 'active')
            throw new BadRequestException(`channel is ${channel.status}`)
        try {
            const action = provider.parseInboundAction?.(
                { headers, body, rawBody },
                ctx
            ) ?? null
            if (action) {
                void this.bridge
                    .handleInboundAction(channel, action)
                    .catch((err) => {
                        this.logger.error(
                            `bridge handleInboundAction failed for channel=${channel.id}: ${(err as Error).message}`
                        )
                    })
                return { ok: true, action: action.action }
            }
            const event = provider.parseInbound({ headers, body, rawBody }, ctx)
            // Some platforms require a specific ack body for this request (e.g.
            // Slack slash commands want an empty-body 200); the default JSON
            // ack would be rendered as a bogus reply.
            const ack =
                event.ackResponse !== undefined ? event.ackResponse : null
            const inbound = await this.repo.insertInboundEvent({
                channelId: channel.id,
                providerEventId: normalizeProviderEventId(
                    event.providerEventId
                ),
                eventJson: event as unknown as Record<string, unknown>,
                summaryText: truncate(event.text, SUMMARY_MAX_LEN),
                createdAt: new Date()
            })
            if (!inbound.created) {
                this.telemetry.event('channel.inbound.ignored', {
                    channelId: channel.id,
                    providerEventId: event.providerEventId,
                    reason: 'duplicate_event_id'
                })
                return ack ?? { ok: true, duplicate: true }
            }
            void this.bridge
                .handleInbound(channel, event, inbound)
                .catch((err) => {
                    this.logger.error(
                        `bridge handleInbound failed for channel=${channel.id}: ${(err as Error).message}`
                    )
                })
            if (ack !== null) return ack
        } catch (err) {
            if (err instanceof UnsupportedEventError) {
                // Silent events (e.g. Slack assistant lifecycle) are pure noise
                // — skip even the recorded system row.
                if (!err.silent)
                    await this.repo.insertDelivery({
                        channelId: channel.id,
                        chatSessionId: null,
                        chatMessageId: null,
                        direction: 'system',
                        scopeKey: 'unsupported',
                        providerEventId: null,
                        providerMessageId: null,
                        summaryText: `skipped event: ${err.eventType}`,
                        status: 'dropped',
                        errorMessage: 'unsupported_event_type',
                        createdAt: new Date()
                    })
                this.telemetry.event('channel.inbound.ignored', {
                    channelId: channel.id,
                    reason: 'unsupported_event_type',
                    eventType: err.eventType
                })
                return { ok: true, skipped: err.eventType }
            }
            this.logger.error(
                `webhook handler failed for channel=${channel.id}: ${(err as Error).message}`
            )
            throw err
        }
        return { ok: true }
    }
}

const truncate = (value: string, max: number): string => {
    if (value.length <= max) return value
    return `${value.slice(0, max - 1)}…`
}
