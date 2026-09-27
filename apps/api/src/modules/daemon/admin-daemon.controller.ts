import type {
    AdminDaemonHostSummary,
    DetectedFramework,
    UpgradeDaemonHostResponse
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Inject,
    NotFoundException,
    Param,
    Post,
    UseGuards
} from '@nestjs/common'
import { count, eq, inArray } from 'drizzle-orm'
import {
    agents,
    agentRuntimes,
    runtimeHosts,
    daemonTokens,
    users,
    type Database
} from '@manyfold/db'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { AdminGuard } from '@/common/guards/admin.guard'
import { DRIZZLE } from '@/db/tokens'
import { HostDaemonsService } from '@/modules/hosts/host-daemons.service'
import { DaemonHostService, type DaemonSummaryRuntime } from './daemon-host.service'
import { CliUpgradeDto } from './dto/cli-upgrade.dto'

// The self-owned computers of every user (ADR-0037: `local` hosts). Hosted
// hosts are listed under the sandboxes and cloud computers admin pages.
@Controller('admin/daemon')
@UseGuards(AuthGuard, AdminGuard)
export class AdminDaemonController {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly hosts: DaemonHostService,
        private readonly hostDaemons: HostDaemonsService
    ) {}

    @Get('hosts')
    async listHosts(): Promise<AdminDaemonHostSummary[]> {
        const hostRows = await this.db
            .select()
            .from(runtimeHosts)
            .where(eq(runtimeHosts.kind, 'local'))
        if (hostRows.length === 0) return []
        const hostIds = hostRows.map((h) => h.id)
        const userIds = [...new Set(hostRows.map((h) => h.userId))]
        const [daemons, runtimeRows, userRows, tokenCountRows, agentCountRows] =
            await Promise.all([
                this.hostDaemons.findByHostIds(hostIds),
                this.db
                    .select({
                        id: agentRuntimes.id,
                        hostId: agentRuntimes.hostId,
                        framework: agentRuntimes.framework,
                        name: agentRuntimes.name,
                        status: agentRuntimes.status
                    })
                    .from(agentRuntimes)
                    .where(inArray(agentRuntimes.hostId, hostIds)),
                this.db
                    .select({ id: users.id, email: users.email })
                    .from(users)
                    .where(inArray(users.id, userIds)),
                this.db
                    .select({
                        hostId: daemonTokens.hostId,
                        count: count()
                    })
                    .from(daemonTokens)
                    .where(inArray(daemonTokens.hostId, hostIds))
                    .groupBy(daemonTokens.hostId),
                this.db
                    .select({ hostId: agentRuntimes.hostId, count: count() })
                    .from(agents)
                    .innerJoin(
                        agentRuntimes,
                        eq(agentRuntimes.id, agents.runtimeId)
                    )
                    .where(inArray(agentRuntimes.hostId, hostIds))
                    .groupBy(agentRuntimes.hostId)
            ])
        const runtimesByHost = new Map<string, DaemonSummaryRuntime[]>()
        for (const r of runtimeRows) {
            if (!r.hostId) continue
            const list = runtimesByHost.get(r.hostId) ?? []
            list.push({
                runtimeId: r.id,
                framework: r.framework as DetectedFramework['framework'],
                name: r.name,
                status: r.status
            })
            runtimesByHost.set(r.hostId, list)
        }
        const emailByUser = new Map<string, string | null>(
            userRows.map((u) => [u.id, u.email])
        )
        const tokenCountByHost = new Map<string, number>()
        for (const row of tokenCountRows)
            if (row.hostId) tokenCountByHost.set(row.hostId, Number(row.count))
        const agentCountByHost = new Map<string, number>()
        for (const row of agentCountRows)
            if (row.hostId) agentCountByHost.set(row.hostId, Number(row.count))
        const result: AdminDaemonHostSummary[] = []
        for (const host of hostRows) {
            const summary = await this.hosts.toSummary(
                host,
                daemons.get(host.id) ?? null,
                runtimesByHost.get(host.id) ?? [],
                agentCountByHost.get(host.id) ?? 0
            )
            result.push({
                ...summary,
                userId: host.userId,
                userEmail: emailByUser.get(host.userId) ?? null,
                tokenCount: tokenCountByHost.get(host.id) ?? 0
            })
        }
        return result
    }

    @Delete('hosts/:id')
    @HttpCode(204)
    async deleteHost(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        await this.hosts.deleteRetired({ id, actorId: user.userId })
    }

    @Post('hosts/:id/upgrade')
    async upgradeHost(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body?: CliUpgradeDto
    ): Promise<UpgradeDaemonHostResponse> {
        const host = await this.hosts.findById(id)
        if (!host) throw new NotFoundException('daemon host not found')
        return this.hosts.upgrade({
            host,
            actorId: user.userId,
            targetVersion: body?.targetVersion
        })
    }
}
