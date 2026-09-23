import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { NotifySyncDto } from './dto/notify-sync.dto'
import { ChannelSendDto } from './dto/channel-send.dto'
import { NarraNexusSyncService } from './narranexus-sync.service'

// No AuthGuard: token-authed internal route (runtime-reports precedent) —
// NarraNexusSyncService verifies the per-runtime report bearer.
@Controller('internal/narranexus-sync')
export class NarraNexusSyncController {
    constructor(private readonly sync: NarraNexusSyncService) {}

    @Post('notify')
    @HttpCode(204)
    async notify(
        @Req() req: FastifyRequest,
        @Body() dto: NotifySyncDto
    ): Promise<void> {
        // Forwarded client IP first (runtime-reports precedent): behind
        // fly-proxy req.ip is the proxy for every request; spoofability is
        // bounded by the post-auth per-runtime window in the service.
        const clientIp =
            (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
            req.ip ??
            'unknown'
        await this.sync.notify(
            clientIp,
            extractBearer(req.headers['authorization']),
            dto
        )
    }

    // Outbound for a hosted channel. Same bearer and windows as notify; the
    // request names a room, never a recipient or a credential.
    @Post('channel-send')
    @HttpCode(200)
    async channelSend(
        @Req() req: FastifyRequest,
        @Body() dto: ChannelSendDto
    ): Promise<{
        deliveryId: string
        status: 'sent' | 'queued' | 'failed'
        providerMessageId: string | null
        deduplicated: boolean
    }> {
        return this.sync.channelSend(
            clientIpOf(req),
            extractBearer(req.headers['authorization']),
            dto
        )
    }
}

const clientIpOf = (req: FastifyRequest): string =>
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
    req.ip ??
    'unknown'

const extractBearer = (
    header: string | string[] | undefined
): string | null => {
    if (!header) return null
    const value = Array.isArray(header) ? header[0] : header
    if (!value.startsWith('Bearer ')) return null
    return value.slice('Bearer '.length).trim() || null
}
