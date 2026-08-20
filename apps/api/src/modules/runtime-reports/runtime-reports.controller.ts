import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { CreateRuntimeReportDto } from './dto/create-runtime-report.dto'
import { RuntimeReportsService } from './runtime-reports.service'

// No AuthGuard: this is a token-authed internal route (daemon/webhook
// precedent) — RuntimeReportsService verifies the per-runtime bearer.
@Controller('internal/runtime-reports')
export class RuntimeReportsController {
    constructor(private readonly reports: RuntimeReportsService) {}

    @Post()
    @HttpCode(204)
    async create(
        @Req() req: FastifyRequest,
        @Body() dto: CreateRuntimeReportDto
    ): Promise<void> {
        // The adapter has no trustProxy, so behind fly-proxy req.ip is the
        // proxy's address for every request — keying the limiter on it would
        // collapse all reporters into one shared bucket. Take the forwarded
        // client IP first (daemon/waitlist/cli-auth precedent); it is
        // spoofable for key rotation, which the post-auth per-runtime limit
        // in the service bounds.
        const clientIp =
            (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
            req.ip ??
            'unknown'
        await this.reports.ingest(
            clientIp,
            extractBearer(req.headers['authorization']),
            dto
        )
    }
}

const extractBearer = (
    header: string | string[] | undefined
): string | null => {
    if (!header) return null
    const value = Array.isArray(header) ? header[0] : header
    if (!value.startsWith('Bearer ')) return null
    return value.slice('Bearer '.length).trim() || null
}
