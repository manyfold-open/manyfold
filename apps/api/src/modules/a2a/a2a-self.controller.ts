import type {
    A2aGrantSummary,
    A2aSelfCallerAddResponse,
    A2aSelfExposure,
    A2aSelfPeer,
    A2aSelfPeerToken,
    A2aTaskTracePage,
    AddA2aSelfCallerBody,
    SetA2aSelfExposureBody
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    HttpCode,
    Param,
    Post,
    Put,
    Query,
    UseGuards
} from '@nestjs/common'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import { AllowBoundTokenWithoutSubject } from '@/common/decorators/subject-agent.decorator'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { principalAgentId } from '@/modules/auth/auth-principal'
import {
    API_TOKEN_SCOPE_A2A,
    API_TOKEN_SCOPE_A2A_READ
} from '@/modules/auth/api-token.service'
import { A2aService } from './a2a.service'
import { A2aSelfService } from './a2a-self.service'

// Agent-self A2A: discover callable peers and mint a per-call bearer in real
// time. Caller identity is the token's bound agent for an agent runtime token;
// for a human token (`mf login`) it is the `agentId` the CLI passes from
// `--agent-id`/$MF_AGENT_ID, verified owned by the user (mirrors how
// `auth ensure`/`channels` scope a human session to one of its agents).
@Controller('agent-self/a2a')
@UseGuards(AuthGuard)
export class A2aSelfController {
    constructor(
        private readonly self: A2aSelfService,
        private readonly a2a: A2aService
    ) {}

    @Get('peers')
    @RequireApiTokenScope(API_TOKEN_SCOPE_A2A_READ)
    @AllowBoundTokenWithoutSubject('agent-self A2A is scoped to the bound agent')
    async peers(
        @CurrentUser() user: AuthPrincipal,
        @Query('agentId') agentId?: string
    ): Promise<A2aSelfPeer[]> {
        return this.self.listPeers(await this.resolveAgent(user, agentId))
    }

    // The calls this agent has made (outbound). Lets an async caller see its
    // in-flight delegations and fetch durable results after its sprite slept —
    // scoped to (owner user, this agent as caller), never another agent's tasks.
    @Get('tasks')
    @RequireApiTokenScope(API_TOKEN_SCOPE_A2A_READ)
    @AllowBoundTokenWithoutSubject('agent-self A2A is scoped to the bound agent')
    async tasks(
        @CurrentUser() user: AuthPrincipal,
        @Query('state') state?: string,
        @Query('peer') peer?: string,
        @Query('cursor') cursor?: string,
        @Query('agentId') agentId?: string
    ): Promise<A2aTaskTracePage> {
        const caller = await this.resolveAgent(user, agentId)
        return this.a2a.listAgentTasks(user.userId, caller, {
            direction: 'outbound',
            state: state?.trim() || undefined,
            peer: peer?.trim() || undefined,
            cursor: cursor?.trim() || undefined
        })
    }

    @Post('peers/:targetAgentId/token')
    @HttpCode(201)
    @RequireApiTokenScope(API_TOKEN_SCOPE_A2A_READ)
    @AllowBoundTokenWithoutSubject('agent-self A2A is scoped to the bound agent')
    async mint(
        @CurrentUser() user: AuthPrincipal,
        @Param('targetAgentId') targetAgentId: string,
        @Query('agentId') agentId?: string
    ): Promise<A2aSelfPeerToken> {
        const caller = await this.resolveAgent(user, agentId)
        return this.self.mintPeerToken(caller, targetAgentId)
    }

    @Get('exposure')
    @RequireApiTokenScope(API_TOKEN_SCOPE_A2A_READ)
    @AllowBoundTokenWithoutSubject(
        'agent-self A2A is scoped to the bound agent'
    )
    async exposure(
        @CurrentUser() user: AuthPrincipal,
        @Query('agentId') agentId?: string
    ): Promise<A2aSelfExposure> {
        const target = await this.resolveAgent(user, agentId)
        const exposure = (await this.a2a.getExposure(target)) ?? {
            enabled: false
        }
        return this.self.exposureView(target, exposure)
    }

    @Put('exposure')
    @RequireApiTokenScope(API_TOKEN_SCOPE_A2A)
    @AllowBoundTokenWithoutSubject(
        'agent-self A2A is scoped to the bound agent'
    )
    async setExposure(
        @CurrentUser() user: AuthPrincipal,
        @Body() body: SetA2aSelfExposureBody,
        @Query('agentId') agentId?: string
    ): Promise<A2aSelfExposure> {
        if (typeof body?.enabled !== 'boolean')
            throw new BadRequestException('enabled must be a boolean')
        const target = await this.resolveAgent(user, agentId)
        const exposure = await this.a2a.setExposure(target, {
            enabled: body.enabled
        })
        return this.self.exposureView(target, exposure)
    }

    @Get('callers')
    @RequireApiTokenScope(API_TOKEN_SCOPE_A2A_READ)
    @AllowBoundTokenWithoutSubject(
        'agent-self A2A is scoped to the bound agent'
    )
    async callers(
        @CurrentUser() user: AuthPrincipal,
        @Query('agentId') agentId?: string
    ): Promise<A2aGrantSummary[]> {
        const target = await this.resolveAgent(user, agentId)
        return this.self.listCallers(user.userId, target)
    }

    @Post('callers')
    @HttpCode(201)
    @RequireApiTokenScope(API_TOKEN_SCOPE_A2A)
    @AllowBoundTokenWithoutSubject(
        'agent-self A2A is scoped to the bound agent'
    )
    async addCaller(
        @CurrentUser() user: AuthPrincipal,
        @Body() body: AddA2aSelfCallerBody,
        @Query('agentId') agentId?: string
    ): Promise<A2aSelfCallerAddResponse> {
        const parsed = parseAddCallerBody(body)
        const target = await this.resolveAgent(user, agentId)
        return this.self.addCaller(user.userId, target, parsed)
    }

    @Delete('callers/:tokenId')
    @HttpCode(204)
    @RequireApiTokenScope(API_TOKEN_SCOPE_A2A)
    @AllowBoundTokenWithoutSubject(
        'agent-self A2A is scoped to the bound agent'
    )
    async revokeCaller(
        @CurrentUser() user: AuthPrincipal,
        @Param('tokenId') tokenId: string,
        @Query('agentId') agentId?: string
    ): Promise<void> {
        const target = await this.resolveAgent(user, agentId)
        await this.self.revokeCaller(user.userId, target, tokenId)
    }

    // Resolve which agent the request acts as. An agent runtime token IS that
    // agent (its bound identity wins; the query is ignored). A human token must
    // name one of its own agents via `agentId` (`--agent-id`), gated by
    // assertOwner so it can never act as an agent it doesn't own.
    private async resolveAgent(
        user: AuthPrincipal,
        agentId?: string
    ): Promise<string> {
        if (user.kind === 'legacy-runtime' && user.tokenKind === 'a2a-grant')
            throw new ForbiddenException(
                'A2A caller grants cannot manage agent A2A settings'
            )
        const bound = principalAgentId(user)
        if (bound) return bound
        const requested = agentId?.trim()
        if (!requested)
            throw new ForbiddenException(
                'this endpoint needs an agent context: pass --agent-id <id> (or use an agent token)'
            )
        await this.a2a.assertOwner(requested, user.userId)
        return requested
    }
}

const parseAddCallerBody = (
    body: AddA2aSelfCallerBody
): AddA2aSelfCallerBody => {
    const raw = body as unknown as Record<string, unknown> | null
    if (!raw || (raw.kind !== 'external' && raw.kind !== 'peer'))
        throw new BadRequestException('kind must be either external or peer')
    if (
        raw.expiresInDays !== undefined &&
        (typeof raw.expiresInDays !== 'number' ||
            !Number.isInteger(raw.expiresInDays) ||
            raw.expiresInDays <= 0)
    )
        throw new BadRequestException(
            'expiresInDays must be a positive integer'
        )
    if (raw.kind === 'external') {
        if ('callerAgentId' in raw || 'replaceExisting' in raw)
            throw new BadRequestException(
                'external callers do not accept callerAgentId or replaceExisting'
            )
        if (raw.name !== undefined && typeof raw.name !== 'string')
            throw new BadRequestException('name must be a string')
        return {
            kind: 'external',
            name:
                typeof raw.name === 'string'
                    ? raw.name.trim() || undefined
                    : undefined,
            expiresInDays: raw.expiresInDays as number | undefined
        }
    }
    if ('name' in raw)
        throw new BadRequestException('peer callers do not accept name')
    const callerAgentId =
        typeof raw.callerAgentId === 'string' ? raw.callerAgentId.trim() : ''
    if (!callerAgentId)
        throw new BadRequestException(
            'callerAgentId is required for peer callers'
        )
    if (
        raw.replaceExisting !== undefined &&
        typeof raw.replaceExisting !== 'boolean'
    )
        throw new BadRequestException('replaceExisting must be a boolean')
    return {
        kind: 'peer',
        callerAgentId,
        expiresInDays: raw.expiresInDays as number | undefined,
        replaceExisting: raw.replaceExisting as boolean | undefined
    }
}
