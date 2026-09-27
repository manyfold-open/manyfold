import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { Inject } from '@nestjs/common'
import { agentAvailability, daemonOnline } from '@manyfold/shared'
import {
    agentRuntimes,
    agents,
    hostDaemons,
    runtimeHosts,
    users,
    type Database
} from '@manyfold/db'
import { corsHeadersForOrigin } from '@/common/cors-headers'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { DRIZZLE } from '@/db/tokens'
import {
    SpriteStatusBroadcaster,
    type AgentHostStatusUpdate,
    type HostStatusEvent
} from '@/modules/agents/sprite-status/sprite-status-broadcaster'

@Controller('agents/sprite-status')
@UseGuards(AuthGuard)
export class SpriteStatusController {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly broadcaster: SpriteStatusBroadcaster
    ) {}

    @Get('stream')
    async stream(
        @CurrentUser() user: AuthPrincipal,
        @Req() req: FastifyRequest,
        @Res() res: FastifyReply
    ): Promise<void> {
        res.hijack()
        res.raw.socket?.setNoDelay(true)
        res.raw.writeHead(200, {
            ...corsHeadersForOrigin(req.headers),
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-accel-buffering': 'no'
        })

        let seq = 0
        const writeEvent = (event: HostStatusEvent): void => {
            seq += 1
            try {
                res.raw.write(`id: ${seq}\n`)
                res.raw.write(`event: ${event.type}\n`)
                res.raw.write(`data: ${JSON.stringify(event)}\n\n`)
            } catch {
                /* socket already gone; cleanup will fire */
            }
        }

        const isAdmin = await this.isAdmin(user.userId)
        const subscriber = {
            send: writeEvent,
            close: (): void => {
                try {
                    res.raw.end()
                } catch {
                    /* ignore */
                }
            },
            isAdmin
        }

        const snapshot = await this.snapshotFor(user.userId)
        writeEvent({
            type: 'snapshot',
            agents: snapshot,
            at: new Date().toISOString()
        })

        const unsubscribe = this.broadcaster.subscribe(user.userId, subscriber)

        const keepalive = setInterval(() => {
            try {
                res.raw.write(`: keepalive ${Date.now()}\n\n`)
            } catch {
                /* socket already gone; cleanup will fire */
            }
        }, 15000)

        const cleanup = (): void => {
            clearInterval(keepalive)
            unsubscribe()
            try {
                res.raw.end()
            } catch {
                /* ignore */
            }
        }
        req.raw.on('close', cleanup)
        req.raw.on('error', cleanup)
    }

    private async isAdmin(userId: string): Promise<boolean> {
        const [row] = await this.db
            .select({ role: users.role })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1)
        return row?.role === 'admin'
    }

    // Every agent with its derived availability: agent → runtime → host →
    // host daemon in one join (ADR-0036); nothing is read off the agent row.
    private async snapshotFor(userId: string): Promise<AgentHostStatusUpdate[]> {
        const rows = await this.db
            .select({
                agent: agents,
                runtime: agentRuntimes,
                host: runtimeHosts,
                daemon: hostDaemons
            })
            .from(agents)
            .innerJoin(agentRuntimes, eq(agentRuntimes.id, agents.runtimeId))
            .leftJoin(runtimeHosts, eq(runtimeHosts.id, agentRuntimes.hostId))
            .leftJoin(hostDaemons, eq(hostDaemons.hostId, runtimeHosts.id))
            .where(eq(agents.userId, userId))
        const now = Date.now()
        return rows.map((r) => ({
            agentId: r.agent.id,
            hostId: r.host?.id ?? null,
            powerState: r.host?.powerState ?? null,
            availability: agentAvailability({
                agent: r.agent,
                runtime: r.runtime,
                host: r.host,
                daemonOnline: daemonOnline(r.daemon, now)
            }),
            at: (r.host?.updatedAt ?? r.agent.updatedAt).toISOString()
        }))
    }
}
