import {
    ForbiddenException,
    Inject,
    Injectable,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import type { RuntimeProviderKind } from '@manyfold/shared'
import {
    runtimeHosts,
    runtimeProviders,
    type Database,
    type RuntimeProvider
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'

export interface PlacementRequest {
    kind: RuntimeProviderKind
    // Pin a provider. Sprites organisations are the platform's and only an
    // admin may pick one; a k8s cluster may be the user's own (BYO).
    providerId?: string | null
    region?: string | null
    callerIsAdmin?: boolean
}

// Which enabled provider a new hosted host lands on (ADR-0037): by kind,
// then priority, region, and — for sprites — the organisation with the
// fewest live hosts, so the wholesale accounts fill evenly.
@Injectable()
export class HostPlacementService {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async selectProvider(request: PlacementRequest): Promise<RuntimeProvider> {
        if (request.providerId) {
            if (request.kind === 'sprites' && !request.callerIsAdmin)
                throw new ForbiddenException(
                    'Only admins may pin a sprites provider'
                )
            const [row] = await this.db
                .select()
                .from(runtimeProviders)
                .where(
                    and(
                        eq(runtimeProviders.id, request.providerId),
                        eq(runtimeProviders.kind, request.kind)
                    )
                )
                .limit(1)
            if (!row)
                throw new NotFoundException(
                    `${request.kind} runtime provider ${request.providerId} not found`
                )
            if (row.status !== 'enabled')
                throw new ServiceUnavailableException(
                    `runtime provider ${row.name} is disabled`
                )
            if (request.kind === 'k8s' && row.lastHealthStatus !== 'ok')
                throw new ServiceUnavailableException(
                    `k8s runtime provider ${row.name} is not available (its last health check failed)`
                )
            return row
        }
        const liveHosts = sql<number>`count(${runtimeHosts.id}) filter (where ${runtimeHosts.status} <> 'retired')::int`
        const rows = await this.db
            .select({ provider: runtimeProviders, liveHosts })
            .from(runtimeProviders)
            .leftJoin(
                runtimeHosts,
                eq(runtimeHosts.providerId, runtimeProviders.id)
            )
            .where(
                and(
                    eq(runtimeProviders.kind, request.kind),
                    eq(runtimeProviders.status, 'enabled'),
                    request.kind === 'k8s'
                        ? eq(runtimeProviders.lastHealthStatus, 'ok')
                        : ne(runtimeProviders.lastHealthStatus, 'failed'),
                    request.region
                        ? eq(runtimeProviders.region, request.region)
                        : undefined
                )
            )
            .groupBy(runtimeProviders.id)
            .orderBy(
                desc(runtimeProviders.priority),
                asc(liveHosts),
                asc(runtimeProviders.createdAt)
            )
            .limit(1)
        const picked = rows[0]?.provider
        if (!picked)
            throw new ServiceUnavailableException(
                request.region
                    ? `no enabled ${request.kind} runtime provider available in region ${request.region}`
                    : `no enabled ${request.kind} runtime provider available`
            )
        return picked
    }
}
