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
import { DaemonHostService } from './daemon-host.service'
import { CliUpgradeDto } from './dto/cli-upgrade.dto'

@Controller('admin/daemon')
@UseGuards(AuthGuard, AdminGuard)
export class AdminDaemonController {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly hosts: DaemonHostService
    ) {}

    @Get('hosts')
    async listHosts(): Promise<AdminDaemonHostSummary[]> {
        const hostRows = await this.db
            .select()
            .from(runtimeHosts)
            .where(eq(runtimeHosts.kind, 'daemon'))
        if (hostRows.length === 0) return []
        const hostIds = hostRows.map((h) => h.id)
        const userIds = [...new Set(hostRows.map((h) => h.userId))]
        const [runtimeRows, userRows, tokenCountRows, agentCountRows] =
            await Promise.all([
                this.db
                    .select({
                        id: agentRuntimes.id,
                        daemonId: agentRuntimes.daemonId,
                        framework: agentRuntimes.framework,
                        name: agentRuntimes.name
                    })
                    .from(agentRuntimes)
                    .where(inArray(agentRuntimes.daemonId, hostIds)),
                this.db
                    .select({ id: users.id, email: users.email })
                    .from(users)
                    .where(inArray(users.id, userIds)),
                this.db
                    .select({
                        daemonId: daemonTokens.daemonId,
                        count: count()
                    })
                    .from(daemonTokens)
                    .where(inArray(daemonTokens.daemonId, hostIds))
                    .groupBy(daemonTokens.daemonId),
                this.db
                    .select({ daemonId: agents.daemonId, count: count() })
                    .from(agents)
                    .where(inArray(agents.daemonId, hostIds))
                    .groupBy(agents.daemonId)
            ])
        const runtimesByDaemon = new Map<
            string,
            Array<{
                runtimeId: string
                framework: DetectedFramework['framework']
                name: string
            }>
        >()
        for (const r of runtimeRows) {
            if (!r.daemonId) continue
            const list = runtimesByDaemon.get(r.daemonId) ?? []
            list.push({
                runtimeId: r.id,
                framework: r.framework as DetectedFramework['framework'],
                name: r.name
            })
            runtimesByDaemon.set(r.daemonId, list)
        }
        const emailByUser = new Map<string, string | null>(
            userRows.map((u) => [u.id, u.email])
        )
        const tokenCountByDaemon = new Map<string, number>()
        for (const row of tokenCountRows)
            if (row.daemonId)
                tokenCountByDaemon.set(row.daemonId, Number(row.count))
        const agentCountByDaemon = new Map<string, number>()
        for (const row of agentCountRows)
            if (row.daemonId)
                agentCountByDaemon.set(row.daemonId, Number(row.count))
        const result: AdminDaemonHostSummary[] = []
        for (const host of hostRows) {
            const summary = await this.hosts.toSummary(
                host,
                runtimesByDaemon.get(host.id) ?? [],
                agentCountByDaemon.get(host.id) ?? 0
            )
            result.push({
                ...summary,
                userId: host.userId,
                userEmail: emailByUser.get(host.userId) ?? null,
                tokenCount: tokenCountByDaemon.get(host.id) ?? 0
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
        await this.hosts.deleteRevoked({ id, actorId: user.userId })
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
