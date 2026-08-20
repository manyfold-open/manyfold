import {
    Controller,
    Get,
    NotFoundException,
    Param,
    Req
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { FastifyRequest } from 'fastify'
import type { AgentCard } from '@manyfold/a2a'
import { publicApiUrlWithApiPrefix } from '@/common/public-api-url'
import { A2aService } from './a2a.service'
import { A2aRateLimitService, clientKey } from './a2a-rate-limit.service'

const CARD_LIMIT_PER_MIN = 60

@Controller('a2a')
export class A2aCardController {
    constructor(
        private readonly a2a: A2aService,
        private readonly config: ConfigService,
        private readonly rateLimit: A2aRateLimitService
    ) {}

    @Get('agents/:agentId/agent-card.json')
    async card(
        @Param('agentId') agentId: string,
        @Req() req: FastifyRequest
    ): Promise<AgentCard> {
        return this.resolveCard(agentId, req)
    }

    // Same card under the path A2A clients probe by convention: given a base
    // URL of …/a2a/agents/:agentId, the official resolvers append
    // '.well-known/agent-card.json'. Without this alias an external client has
    // to be handed the exact card URL by hand.
    @Get('agents/:agentId/.well-known/agent-card.json')
    async wellKnownCard(
        @Param('agentId') agentId: string,
        @Req() req: FastifyRequest
    ): Promise<AgentCard> {
        return this.resolveCard(agentId, req)
    }

    private async resolveCard(
        agentId: string,
        req: FastifyRequest
    ): Promise<AgentCard> {
        this.rateLimit.consume({
            key: `a2a:card:${clientKey(req)}:${agentId}`,
            limit: CARD_LIMIT_PER_MIN,
            windowMs: 60_000
        })
        const card = await this.a2a.buildAgentCard(agentId, this.apiOrigin(req))
        // Uniform 404 for unknown OR not-exposed agents — never leak existence.
        if (!card) throw new NotFoundException('agent not found')
        return card
    }

    private apiOrigin(req: FastifyRequest): string {
        const configured = this.config.get<string>('PUBLIC_API_BASE_URL')
        if (configured && configured.length > 0)
            return publicApiUrlWithApiPrefix(configured)
        const proto =
            (req.headers['x-forwarded-proto'] as string | undefined) || 'https'
        const host = req.headers.host ?? 'localhost'
        return `${proto}://${host}/api`
    }
}
