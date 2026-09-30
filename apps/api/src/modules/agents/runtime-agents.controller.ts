import {
    AGENT_CREATE_REQUEST_HEADER,
    type AgentFramework,
    type AgentRuntimeSummary,
    type AgentSummary,
    type FrameworkAgentSummary,
    type FrameworkUpgradeEvent,
    type FrameworkUpgradeStep
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Get,
    Headers,
    HttpCode,
    Inject,
    NotFoundException,
    Param,
    Post,
    Res,
    UseGuards
} from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import type { AgentRuntimeRow } from '@manyfold/db'
import { corsHeadersForOrigin } from '@/common/cors-headers'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { AdminGuard } from '@/common/guards/admin.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import { SubjectAgentFromResource } from '@/common/decorators/subject-agent.decorator'
import {
    ACQUISITION_PORT,
    type AcquisitionPort
} from '@/common/ports/acquisition.ports'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { AgentAdapterRegistry } from '@/modules/agents/adapters/adapter-registry'
import {
    agentRowToSummary,
    summaryRowOf
} from '@/modules/agents/agents.service'
import { AgentCreateRequestsService } from '@/modules/agents/create-requests/agent-create-requests.service'
import { AddRuntimeAgentDto } from '@/modules/agents/dto/add-runtime-agent.dto'
import { UpgradeFrameworkVersionDto } from '@/modules/agents/dto/upgrade-framework-version.dto'
import { sanitizeMessage } from '@/modules/agents/failure-report'
import { FrameworkVersionProbeService } from '@/modules/agents/framework-versions/framework-version-probe.service'
import {
    FrameworkUpgradeService,
    type FrameworkUpgradeEmitter
} from '@/modules/agents/framework-versions/framework-upgrade.service'
import {
    RuntimeAgentAttachService,
    type AttachAgentInput
} from '@/modules/agents/orchestration/runtime-agent-attach.service'
import {
    RuntimeContextService,
    type RuntimeContext
} from '@/modules/hosts/runtime-context.service'

@Controller('agent-runtimes')
@UseGuards(AuthGuard)
export class RuntimeAgentsController {
    constructor(
        private readonly runtimes: AgentRuntimesService,
        private readonly adapterRegistry: AgentAdapterRegistry,
        private readonly attach: RuntimeAgentAttachService,
        private readonly runtimeContext: RuntimeContextService,
        @Inject(ACQUISITION_PORT)
        private readonly attribution: AcquisitionPort,
        private readonly createRequests: AgentCreateRequestsService,
        private readonly frameworkVersionProbe: FrameworkVersionProbeService,
        private readonly frameworkUpgrade: FrameworkUpgradeService
    ) {}

    @Post(':id/agents')
    @HttpCode(201)
    @RequireApiTokenScope('agents:edit')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async addAgent(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') runtimeId: string,
        @Body() dto: AddRuntimeAgentDto,
        @Res({ passthrough: true }) res: FastifyReply,
        @Headers(AGENT_CREATE_REQUEST_HEADER) resume?: string
    ): Promise<AgentSummary> {
        const runtime = await this.runtimes.findById(runtimeId)
        if (!runtime || runtime.userId !== user.userId)
            throw new NotFoundException(`agent runtime ${runtimeId} not found`)
        const summary = await addClaimedAgent({
            createRequests: this.createRequests,
            attach: this.attach,
            runtimeContext: this.runtimeContext,
            actorUserId: user.userId,
            res,
            resume,
            dto,
            input: { runtime, expectedOwnerUserId: user.userId }
        })
        // This route never enters orchestrator.create, so the activation
        // conversion hooks here; the owner check above guarantees actor ==
        // owner. The admin controller below is on-behalf and doesn't count.
        await this.attribution.recordFirstAgentCreated({
            userId: user.userId
        })
        return summary
    }

    @Get(':id/framework-agents')
    @RequireApiTokenScope('agents:read')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async listFrameworkAgents(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') runtimeId: string
    ): Promise<FrameworkAgentSummary[]> {
        const ctx = await this.runtimeContext.forRuntime(runtimeId)
        if (!ctx || ctx.runtime.userId !== user.userId)
            throw new NotFoundException(`agent runtime ${runtimeId} not found`)
        return listFrameworkAgents(this.adapterRegistry, ctx)
    }

    // A framework install belongs to its runtime (host + framework), whatever
    // agents run on it.
    @Post(':id/framework-version/refresh')
    @HttpCode(200)
    @RequireApiTokenScope('agent-runtimes:edit')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async refreshFrameworkVersion(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AgentRuntimeSummary> {
        await this.frameworkVersionProbe.probeAndPersist(
            await this.owned(id, user.userId)
        )
        return this.summaryOf(id)
    }

    @Post(':id/framework-version/upgrade')
    @HttpCode(200)
    @RequireApiTokenScope('agent-runtimes:edit')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async upgradeFrameworkVersion(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpgradeFrameworkVersionDto
    ): Promise<AgentRuntimeSummary> {
        await this.frameworkUpgrade.upgrade(
            await this.owned(id, user.userId),
            dto.targetVersion,
            false
        )
        return this.summaryOf(id)
    }

    @Post(':id/framework-version/upgrade-stream')
    @RequireApiTokenScope('agent-runtimes:edit')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async upgradeFrameworkStream(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpgradeFrameworkVersionDto,
        @Res() res: FastifyReply
    ): Promise<void> {
        const runtime = await this.owned(id, user.userId)
        await streamFrameworkUpgrade(res, async (emitter) => {
            await this.frameworkUpgrade.upgradeStreaming(
                runtime,
                dto.targetVersion,
                false,
                emitter
            )
            return this.summaryOf(id)
        })
    }

    private async owned(id: string, userId: string): Promise<AgentRuntimeRow> {
        const runtime = await this.runtimes.findById(id)
        if (!runtime || runtime.userId !== userId)
            throw new NotFoundException(`agent runtime ${id} not found`)
        return runtime
    }

    private async summaryOf(id: string): Promise<AgentRuntimeSummary> {
        const runtime = await this.runtimes.findById(id)
        if (!runtime) throw new NotFoundException(`agent runtime ${id} not found`)
        return this.runtimes.toSummary(runtime)
    }
}

@Controller('admin/agent-runtimes')
@UseGuards(AuthGuard, AdminGuard)
export class AdminRuntimeAgentsController {
    constructor(
        private readonly runtimes: AgentRuntimesService,
        private readonly adapterRegistry: AgentAdapterRegistry,
        private readonly attach: RuntimeAgentAttachService,
        private readonly runtimeContext: RuntimeContextService,
        private readonly createRequests: AgentCreateRequestsService,
        private readonly frameworkVersionProbe: FrameworkVersionProbeService,
        private readonly frameworkUpgrade: FrameworkUpgradeService
    ) {}

    @Post(':id/agents')
    @HttpCode(201)
    async addAgent(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') runtimeId: string,
        @Body() dto: AddRuntimeAgentDto,
        @Res({ passthrough: true }) res: FastifyReply,
        @Headers(AGENT_CREATE_REQUEST_HEADER) resume?: string
    ): Promise<AgentSummary> {
        const runtime = await this.runtimes.findById(runtimeId)
        if (!runtime)
            throw new NotFoundException(`agent runtime ${runtimeId} not found`)
        // Admin on-behalf: the agent lands in the runtime owner's account.
        return addClaimedAgent({
            createRequests: this.createRequests,
            attach: this.attach,
            runtimeContext: this.runtimeContext,
            actorUserId: user.userId,
            res,
            resume,
            dto,
            input: { runtime, expectedOwnerUserId: runtime.userId }
        })
    }

    @Get(':id/framework-agents')
    async listFrameworkAgents(
        @Param('id') runtimeId: string
    ): Promise<FrameworkAgentSummary[]> {
        const ctx = await this.runtimeContext.forRuntime(runtimeId)
        if (!ctx)
            throw new NotFoundException(`agent runtime ${runtimeId} not found`)
        return listFrameworkAgents(this.adapterRegistry, ctx)
    }

    @Post(':id/framework-version/refresh')
    @HttpCode(200)
    async refreshFrameworkVersion(
        @Param('id') id: string
    ): Promise<AgentRuntimeSummary> {
        await this.frameworkVersionProbe.probeAndPersist(await this.found(id))
        return this.runtimes.toSummary(await this.found(id))
    }

    @Post(':id/framework-version/upgrade')
    @HttpCode(200)
    async upgradeFrameworkVersion(
        @Param('id') id: string,
        @Body() dto: UpgradeFrameworkVersionDto
    ): Promise<AgentRuntimeSummary> {
        await this.frameworkUpgrade.upgrade(
            await this.found(id),
            dto.targetVersion,
            true
        )
        return this.runtimes.toSummary(await this.found(id))
    }

    @Post(':id/framework-version/upgrade-stream')
    async upgradeFrameworkStream(
        @Param('id') id: string,
        @Body() dto: UpgradeFrameworkVersionDto,
        @Res() res: FastifyReply
    ): Promise<void> {
        const runtime = await this.found(id)
        await streamFrameworkUpgrade(res, async (emitter) => {
            await this.frameworkUpgrade.upgradeStreaming(
                runtime,
                dto.targetVersion,
                true,
                emitter
            )
            return this.runtimes.toSummary(await this.found(id))
        })
    }

    private async found(id: string): Promise<AgentRuntimeRow> {
        const runtime = await this.runtimes.findById(id)
        if (!runtime) throw new NotFoundException(`agent runtime ${id} not found`)
        return runtime
    }
}

// A rebuild upgrade streamed as NDJSON. The response only starts with the
// first event, so a refusal before any work stays a plain HTTP error.
const streamFrameworkUpgrade = async (
    res: FastifyReply,
    run: (emitter: FrameworkUpgradeEmitter) => Promise<AgentRuntimeSummary>
): Promise<void> => {
    let started = false
    const write = (ev: FrameworkUpgradeEvent): void => {
        if (!started) {
            res.hijack()
            res.raw.writeHead(200, {
                ...corsHeadersForOrigin(res.request.headers),
                'content-type': 'application/x-ndjson',
                'cache-control': 'no-cache',
                'x-accel-buffering': 'no'
            })
            started = true
        }
        res.raw.write(JSON.stringify(ev) + '\n')
    }
    let lastStep: FrameworkUpgradeStep | null = null
    try {
        const runtime = await run({
            step: (s): void => {
                lastStep = s
                write({ type: 'step', step: s })
            }
        })
        write({ type: 'complete', runtime })
    } catch (err) {
        if (!started) throw err
        write({ type: 'error', step: lastStep, message: sanitizeMessage(err) })
    } finally {
        if (started) res.raw.end()
    }
}

// Add-agent under a create request, like POST /agents: the name is held
// while the agent is installed, and repeating the request while it runs
// returns the agent it produced instead of adding a second one.
const addClaimedAgent = async (args: {
    createRequests: AgentCreateRequestsService
    attach: RuntimeAgentAttachService
    runtimeContext: RuntimeContextService
    actorUserId: string
    res: FastifyReply
    resume?: string
    dto: AddRuntimeAgentDto
    input: Pick<AttachAgentInput, 'runtime' | 'expectedOwnerUserId'>
}): Promise<AgentSummary> => {
    const { dto, input } = args
    const claim = await args.createRequests.claim({
        userId: input.runtime.userId,
        actorUserId: args.actorUserId,
        name: dto.name,
        fingerprint: args.createRequests.fingerprint('add', dto, {
            runtimeId: input.runtime.id
        }),
        resume: args.resume
    })
    void args.res.header(AGENT_CREATE_REQUEST_HEADER, claim.request.id)
    return args.createRequests.execute(
        claim,
        undefined,
        () =>
            args.attach.attach({
                ...input,
                name: dto.name,
                workspace: dto.workspace,
                model: dto.model,
                cloneFrom: dto.cloneFrom,
                modelConfigSource: dto.modelConfigSource,
                runtimeAuthProfileId: dto.runtimeAuthProfileId
            }),
        async (agentId) => {
            const ctx = await args.runtimeContext.forAgent(agentId)
            if (!ctx?.agent)
                throw new NotFoundException(`agent ${agentId} not found`)
            return agentRowToSummary(summaryRowOf({ ...ctx, agent: ctx.agent }))
        }
    )
}

const SUPPORTED_FRAMEWORKS_FOR_LIVE_AGENTS: ReadonlySet<AgentFramework> =
    new Set<AgentFramework>([
        'claude-code',
        'codex',
        'gemini-cli',
        'pi',
        'antigravity-cli',
        'openclaw',
        'hermes'
    ])

const listFrameworkAgents = async (
    adapterRegistry: AgentAdapterRegistry,
    ctx: RuntimeContext
): Promise<FrameworkAgentSummary[]> => {
    const { runtime } = ctx
    if (!SUPPORTED_FRAMEWORKS_FOR_LIVE_AGENTS.has(runtime.framework))
        throw new ConflictException(
            `framework ${runtime.framework} does not support live agent listing`
        )
    if (!ctx.host) throw new BadRequestException('runtime has no host')
    const adapter = adapterRegistry.get(runtime.framework)
    return adapter.listAgents(ctx)
}

