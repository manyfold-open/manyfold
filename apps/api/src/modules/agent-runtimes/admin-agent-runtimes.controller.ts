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
    Controller,
    Delete,
    Get,
    HttpCode,
    Inject,
    InternalServerErrorException,
    NotFoundException,
    Param,
    Patch,
    Query,
    UseGuards
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { agentRuntimes, agents, type Database } from '@manyfold/db'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { AdminGuard } from '@/common/guards/admin.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { DRIZZLE } from '@/db/tokens'
import { AgentRuntimesService } from './agent-runtimes.service'
import { SpritesProvisioner } from './provisioning/sprites-provisioner'
import { K8sProvisioner } from './provisioning/k8s-provisioner'
import { RuntimeDashboardService } from './orchestration/runtime-dashboard.service'

@Controller('admin/agent-runtimes')
@UseGuards(AuthGuard, AdminGuard)
export class AdminAgentRuntimesController {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly runtimes: AgentRuntimesService,
        private readonly spritesProvisioner: SpritesProvisioner,
        private readonly k8sProvisioner: K8sProvisioner,
        private readonly dashboard: RuntimeDashboardService
    ) {}

    @Get()
    async list(): Promise<AgentRuntimeSummary[]> {
        const rows = await this.db.select().from(agentRuntimes)
        return this.runtimes.toSummaries(rows)
    }

    @Get(':id')
    async get(@Param('id') id: string): Promise<AgentRuntimeSummary> {
        const [row] = await this.db
            .select()
            .from(agentRuntimes)
            .where(eq(agentRuntimes.id, id))
            .limit(1)
        if (!row) throw new NotFoundException(`agent runtime ${id} not found`)
        return this.runtimes.toSummary(row)
    }

    @Delete(':id')
    @HttpCode(204)
    async delete(@Param('id') id: string): Promise<void> {
        const [row] = await this.db
            .select()
            .from(agentRuntimes)
            .where(eq(agentRuntimes.id, id))
            .limit(1)
        if (!row) throw new NotFoundException(`agent runtime ${id} not found`)
        if (row.kind === 'sprites') {
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
            return
        }
        throw new InternalServerErrorException(
            `unknown runtime kind: ${row.kind}`
        )
    }

    @Patch(':id/control-ui')
    @HttpCode(200)
    async setControlUi(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: SetControlUiBody
    ): Promise<AgentRuntimeSummary> {
        return this.dashboard.setControlUi(user.userId, id, !!body.enabled, true)
    }

    @Get(':id/control-ui-url')
    @HttpCode(200)
    async getControlUiUrl(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Query('agentId') agentId?: string
    ): Promise<AgentControlUiUrlResponse> {
        return this.dashboard.getControlUiUrl(id, user.userId, true, agentId)
    }

    @Patch(':id/dashboard')
    @HttpCode(200)
    async setDashboard(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: SetDashboardBody
    ): Promise<AgentRuntimeSummary> {
        return this.dashboard.setDashboard(user.userId, id, !!body.enabled, true)
    }

    @Patch(':id/keep-alive')
    @HttpCode(200)
    async setKeepAlive(
        @Param('id') id: string,
        @Body() body: SetKeepAliveBody
    ): Promise<AgentRuntimeSummary> {
        const row = await this.runtimes.findById(id)
        if (!row) throw new NotFoundException(`agent runtime ${id} not found`)
        if (row.kind !== 'sprites' || isExternal(row.framework))
            throw new BadRequestException({
                message: 'keep-alive is not supported for this runtime',
                code: 'KEEP_ALIVE_UNSUPPORTED'
            })
        // Drive caps + lease against the runtime OWNER, not the admin caller.
        const next = await this.spritesProvisioner.setKeepAlive(
            row.userId,
            row,
            !!body.enabled
        )
        return this.runtimes.toSummary(next)
    }
}
