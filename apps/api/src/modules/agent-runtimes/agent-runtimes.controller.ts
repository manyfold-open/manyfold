import { isExternal } from '@manyfold/shared'
import type {
    AgentControlUiUrlResponse,
    AgentRuntimeSummary,
    SetControlUiBody,
    SetDashboardBody,
    SetKeepAliveBody
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Delete,
    Get,
    HttpCode,
    Inject,
    InternalServerErrorException,
    NotFoundException,
    Param,
    Patch,
    Optional,
    Query,
    UseGuards
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { agents, type Database } from '@manyfold/db'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import {
    ListFilteredByBoundAgent,
    SubjectAgentFromResource
} from '@/common/decorators/subject-agent.decorator'
import { boundAgentIdFromUser } from '@/modules/agents/agents.controller'
import { DRIZZLE } from '@/db/tokens'
import {
    CLOUD_COMPUTER_PORT,
    type CloudComputerPort
} from '@/common/ports/cloud-computer.ports'
import { AgentRuntimesService } from './agent-runtimes.service'
import { RenameRuntimeDto } from './dto/rename-runtime.dto'
import { SpritesProvisioner } from './provisioning/sprites-provisioner'
import { K8sProvisioner } from './provisioning/k8s-provisioner'
import { RuntimeDashboardService } from './orchestration/runtime-dashboard.service'

@Controller('agent-runtimes')
@UseGuards(AuthGuard)
export class AgentRuntimesController {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly runtimes: AgentRuntimesService,
        private readonly spritesProvisioner: SpritesProvisioner,
        private readonly k8sProvisioner: K8sProvisioner,
        private readonly dashboard: RuntimeDashboardService,
        // Appended last + @Optional so positional test construction keeps
        // working; absence means the open default (no-op teardown hook).
        @Optional()
        @Inject(CLOUD_COMPUTER_PORT)
        private readonly cloudComputer?: CloudComputerPort
    ) {}

    @Get()
    @RequireApiTokenScope('agent-runtimes:read')
    @ListFilteredByBoundAgent()
    async list(@CurrentUser() user: AuthPrincipal): Promise<AgentRuntimeSummary[]> {
        const rows = await this.runtimes.listByUser(user.userId, {
            boundAgentId: boundAgentIdFromUser(user)
        })
        return this.runtimes.toSummaries(rows)
    }

    @Get(':id')
    @RequireApiTokenScope('agent-runtimes:read')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async get(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AgentRuntimeSummary> {
        const row = await this.runtimes.findById(id)
        if (!row || row.userId !== user.userId)
            throw new NotFoundException(`agent runtime ${id} not found`)
        return this.runtimes.toSummary(row)
    }

    @Delete(':id')
    @HttpCode(204)
    @RequireApiTokenScope('agent-runtimes:edit')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async delete(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        const row = await this.runtimes.findById(id)
        if (!row || row.userId !== user.userId)
            throw new NotFoundException(`agent runtime ${id} not found`)
        if (row.kind === 'sprites') {
            // Explicit runtime delete stays destructive: drop the VM too if this
            // empties the host (vs deleting an agent, which preserves it).
            await this.spritesProvisioner.teardownRuntime(row, {
                reapImmediatelyIfEmpty: true
            })
            return
        }
        if (row.kind === 'k8s') {
            const [firstAgent] = await this.db
                .select({ id: agents.id })
                .from(agents)
                .where(eq(agents.runtimeId, row.id))
                .limit(1)
            await this.k8sProvisioner.teardownRuntime(
                row,
                firstAgent?.id ?? row.id
            )
            await this.cloudComputer?.onRuntimeTeardown(row.id)
            return
        }
        if (row.kind === 'daemon')
            // Daemon runtimes are derived state: daemon-runtime-sync creates one
            // per framework the daemon detects and only marks vanished ones
            // 'stopped'. The single place they are removed is the host lifecycle
            // (revoke, then permanent delete, which drops them in one tx), so
            // there is nothing sensible for this route to do beyond saying so.
            throw new ConflictException({
                code: 'runtime.daemon_managed',
                message:
                    'daemon runtimes are managed by their local daemon host; revoke the host and then delete it permanently to remove them'
            })
        if (row.kind === 'external') {
            // agents.runtime_id cascades on delete, so removing this row would
            // silently take the agent with it. External runtimes are created
            // 1:1 by the external provisioner during agent creation and torn
            // down when that agent is deleted — refuse while one is bound.
            const [bound] = await this.db
                .select({ id: agents.id })
                .from(agents)
                .where(eq(agents.runtimeId, row.id))
                .limit(1)
            if (bound)
                throw new ConflictException({
                    code: 'runtime.external_agent_bound',
                    message: `this runtime belongs to external agent ${bound.id}; delete the agent instead`
                })
            await this.runtimes.delete(row.id)
            return
        }
        throw new InternalServerErrorException(
            `unknown runtime kind: ${row.kind}`
        )
    }

    @Patch(':id/name')
    @HttpCode(200)
    @RequireApiTokenScope('agent-runtimes:edit')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async rename(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: RenameRuntimeDto
    ): Promise<AgentRuntimeSummary> {
        const updated = await this.runtimes.rename(user.userId, id, body.name)
        return this.runtimes.toSummary(updated)
    }

    @Patch(':id/control-ui')
    @HttpCode(200)
    @RequireApiTokenScope('agent-runtimes:edit')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async setControlUi(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: SetControlUiBody
    ): Promise<AgentRuntimeSummary> {
        return this.dashboard.setControlUi(user.userId, id, !!body.enabled, false)
    }

    @Get(':id/control-ui-url')
    @HttpCode(200)
    @RequireApiTokenScope('agent-runtimes:read')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async getControlUiUrl(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Query('agentId') agentId?: string
    ): Promise<AgentControlUiUrlResponse> {
        return this.dashboard.getControlUiUrl(id, user.userId, false, agentId)
    }

    @Patch(':id/dashboard')
    @HttpCode(200)
    @RequireApiTokenScope('agent-runtimes:edit')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async setDashboard(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: SetDashboardBody
    ): Promise<AgentRuntimeSummary> {
        return this.dashboard.setDashboard(user.userId, id, !!body.enabled, false)
    }

    @Patch(':id/keep-alive')
    @HttpCode(200)
    @RequireApiTokenScope('agent-runtimes:edit')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async setKeepAlive(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: SetKeepAliveBody
    ): Promise<AgentRuntimeSummary> {
        const row = await this.runtimes.findById(id)
        if (!row || row.userId !== user.userId)
            throw new NotFoundException(`agent runtime ${id} not found`)
        if (row.kind !== 'sprites' || isExternal(row.framework))
            throw new BadRequestException({
                message: 'keep-alive is not supported for this runtime',
                code: 'KEEP_ALIVE_UNSUPPORTED'
            })
        const next = await this.spritesProvisioner.setKeepAlive(
            user.userId,
            row,
            !!body.enabled
        )
        return this.runtimes.toSummary(next)
    }
}
