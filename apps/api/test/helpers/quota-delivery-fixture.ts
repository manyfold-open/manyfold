import { eq, sql } from 'drizzle-orm'
import { users, userSessions, type Database } from '@manyfold/db'
import { createObjectId, type QuotaWarningEvent } from '@manyfold/shared'
import { createClient } from '@manyfold/sdk'
import type { AuthPrincipal } from '../../src/common/guards/auth.guard'
import type { UsagePeriodPort } from '../../src/common/ports/usage-period.ports'
import { SpriteStatusBus } from '../../src/modules/agents/sprite-status/sprite-status-bus'
import { SpriteStatusBroadcaster } from '../../src/modules/agents/sprite-status/sprite-status-broadcaster'
import { SpriteStatusSyncService } from '../../src/modules/agents/sprite-status/sprite-status-sync.service'
import { createQuotaFixture } from './quota-fixture'
import { createQuotaHttpFixture } from './quota-http-fixture'

export const deferred = <T = void>() => {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    let timer: ReturnType<typeof setTimeout>
    const promise = new Promise<T>((yes, no) => {
        resolve = (value) => {
            clearTimeout(timer)
            yes(value)
        }
        reject = (error) => {
            clearTimeout(timer)
            no(error)
        }
        timer = setTimeout(
            () => reject(new Error('quota fixture barrier timed out')),
            10_000
        )
    })
    void promise.catch(() => {})
    return { promise, resolve, reject }
}

export const withDeliveryFixture = async <T>(
    first: Database,
    second: Database,
    body: (
        fixture: Awaited<ReturnType<typeof buildDeliveryFixture>>
    ) => Promise<T>,
    period?: UsagePeriodPort
): Promise<T> => {
    const h = await buildDeliveryFixture(first, second, period)
    try {
        return await body(h)
    } finally {
        await h.close()
    }
}

const buildDeliveryFixture = async (
    first: Database,
    second: Database,
    period?: UsagePeriodPort
) => {
    const h = await createQuotaFixture(first, period)
    const otherUserId = createObjectId('user')
    await first
        .insert(users)
        .values({ id: otherUserId, email: `${otherUserId}@fixture.invalid` })
    await first
        .insert(userSessions)
        .values({
            id: createObjectId('userSession'),
            userId: h.userId,
            tokenHash: h.userId,
            provider: 'email',
            subject: h.userId,
            lastUsedAt: sql`now()`,
            expiresAt: sql`now() + interval '1 day'`
        })
    const busA = new SpriteStatusBus(first),
        busB = new SpriteStatusBus(second)
    const broadcasterA = new SpriteStatusBroadcaster(busA),
        broadcasterB = new SpriteStatusBroadcaster(busB)
    await (
        busA as unknown as { startListening: () => Promise<void> }
    ).startListening()
    await (
        busB as unknown as { startListening: () => Promise<void> }
    ).startListening()
    const accessB = h.makeAccess(second)
    const principals: Record<string, AuthPrincipal> = {
        human: {
            kind: 'human-session',
            provider: 'email',
            subject: h.userId,
            userId: h.userId
        },
        full: {
            kind: 'human-api-token',
            tokenId: 'fixture-full',
            scopes: ['api.full'],
            userId: h.userId
        },
        other: {
            kind: 'human-session',
            provider: 'email',
            subject: otherUserId,
            userId: otherUserId
        },
        narrow: {
            kind: 'human-api-token',
            tokenId: 'fixture-narrow',
            scopes: ['agents:read'],
            userId: h.userId
        },
        runtime: {
            kind: 'agent-runtime',
            agentId: h.agentId,
            runtimeTokenId: 'fixture-runtime',
            userId: h.userId
        }
    }
    const apiA = await createQuotaHttpFixture(
        first,
        h.runtimeAccess,
        broadcasterA,
        principals
    )
    const api = await createQuotaHttpFixture(
        second,
        accessB,
        broadcasterB,
        principals
    )
    const sync = new SpriteStatusSyncService(
        first,
        {} as never,
        {} as never,
        broadcasterA,
        { event: () => {} } as never,
        {} as never,
        h.runtimeAccess,
        h.settings as never,
        {} as never,
        {} as never
    )
    const streams: Array<{ close: () => void }> = []
    const client = (token = 'human', instance: 'first' | 'second' = 'second') =>
        createClient({
            baseUrl: instance === 'first' ? apiA.baseUrl : api.baseUrl,
            token,
            accountScope: true
        })
    const subscribe = async (
        onWarning: (event: QuotaWarningEvent) => void,
        token = 'human'
    ) => {
        const ready = deferred()
        const errors: Error[] = []
        const stream = client(token).agents.streamSpriteStatus({
            onSnapshot: () => ready.resolve(),
            onQuotaWarning: onWarning,
            onError: (error) => {
                errors.push(error)
                ready.reject(error)
            }
        })
        streams.push(stream)
        await ready.promise
        return { stream, errors }
    }
    return {
        ...h,
        accessB,
        api,
        apiA,
        client,
        subscribe,
        busA,
        busB,
        broadcasterA,
        broadcasterB,
        tickWarnings: () =>
            (
                sync as unknown as { tickQuotaWarnings: () => Promise<void> }
            ).tickQuotaWarnings(),
        readUser: async () =>
            (await first.select().from(users).where(eq(users.id, h.userId)))[0],
        close: async () => {
            for (const stream of streams) stream.close()
            await apiA.close()
            await api.close()
            await busA.onApplicationShutdown()
            await busB.onApplicationShutdown()
            await first.delete(users).where(eq(users.id, otherUserId))
            await h.close()
        }
    }
}
