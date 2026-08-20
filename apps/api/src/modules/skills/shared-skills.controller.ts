import type { SharedSkillPreview } from '@manyfold/shared'
import { Controller, Get, Param, Req } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { LibrarySkillSharesService } from './library-skill-shares.service'
import {
    clientKey,
    ShareRateLimitService
} from '@/common/share-rate-limit.service'

const SHARED_PREVIEW_LIMIT_PER_MIN = 60

// Unauthenticated on purpose: the share id is the capability (unlisted-link
// semantics). Keyed per-IP only — a per-id bucket would hand an enumerating
// client a fresh quota for every guess.
@Controller('skills/shared')
export class SharedSkillsController {
    constructor(
        private readonly shares: LibrarySkillSharesService,
        private readonly rateLimit: ShareRateLimitService
    ) {}

    @Get(':shareId')
    preview(
        @Param('shareId') shareId: string,
        @Req() req: FastifyRequest
    ): Promise<SharedSkillPreview> {
        this.rateLimit.consume({
            key: `skills:shared:${clientKey(req)}`,
            limit: SHARED_PREVIEW_LIMIT_PER_MIN,
            windowMs: 60_000
        })
        return this.shares.buildPublicPreview(shareId)
    }
}
