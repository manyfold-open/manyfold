import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    automations,
    automationRuns,
    chatMessages,
    chatSessions,
    plans,
    users,
    type Database
} from '@manyfold/db'
import { createObjectId } from '@manyfold/shared'
import { AutomationsService } from '../../src/modules/automations/automations.service'
import { RuntimeAccessService } from '../../src/modules/runtime-access/runtime-access.service'
import { SandboxActiveDurationService } from '../../src/modules/agents/sandbox-active-duration/sandbox-active-duration.service'
import {
    calendarUsagePeriodPort,
    type UsagePeriodPort
} from '../../src/common/ports/usage-period.ports'

export const exhaustedAt = new Date('2026-04-10T09:30:00.000Z')
export const restoredAt = new Date('2026-04-20T09:30:00.000Z')
export const nextNatural = new Date('2026-04-20T10:00:00.000Z')
const rrule = 'RRULE:FREQ=HOURLY;BYMINUTE=0;BYSECOND=0'

export const createQuotaFixture = async (
    db: Database,
    period: UsagePeriodPort = calendarUsagePeriodPort
) => {
    const userId = createObjectId('user'),
        agentId = createObjectId('agent')
    const runtimeId = createObjectId('agentRuntime'),
        automationId = createObjectId('automation')
    const planId = `plan_${userId}`,
        expandedPlanId = `expanded_${userId}`
    for (const [id, limit] of [
        [planId, 1],
        [expandedPlanId, 100]
    ] as const)
        await db.insert(plans).values({
            id,
            name: 'Quota fixture',
            maxAgentsProvisioned: 50,
            maxConcurrentActive: 50,
            maxStorageGb: 50,
            maxChannels: 50,
            maxAutomations: 50,
            maxAutomationRunsMonthly: limit,
            monthlyActiveHoursIncluded: 1000,
            monthlyApiRequestLimit: null
        })
    await db
        .insert(users)
        .values({ id: userId, email: `${userId}@fixture.invalid`, planId })
    await db
        .insert(agentRuntimes)
        .values({
            id: runtimeId,
            userId,
            name: 'Quota fixture',
            framework: 'claude-code',
            kind: 'sprites'
        })
    await db
        .insert(agents)
        .values({
            id: agentId,
            userId,
            runtimeId,
            name: 'Quota fixture',
            framework: 'claude-code',
            runtime: 'sprites',
            internalId: agentId,
            status: 'running'
        })
    await db.insert(automations).values({
        id: automationId,
        userId,
        agentId,
        title: 'Quota fixture',
        prompt: 'fixture',
        schedulePreset: 'hourly',
        rrule,
        timezone: 'UTC',
        dtstart: new Date('2026-04-01T00:00:00.000Z'),
        nextRunAt: exhaustedAt,
        updatedAt: sql`'2026-04-09T12:34:56.123456Z'::timestamptz`
    })
    await db.insert(automationRuns).values({
        id: createObjectId('automationRun'),
        automationId,
        userId,
        agentId,
        trigger: 'scheduled',
        status: 'succeeded',
        titleSnapshot: 'fixture',
        promptSnapshot: 'fixture',
        rruleSnapshot: rrule,
        startedAt: new Date('2026-04-09T09:00:00.000Z'),
        finishedAt: exhaustedAt
    })
    const settings = {
        isFeatureEnabled: async () => false,
        getCachedSpritesEffectiveCap: async () => ({
            activeCap: 1_000_000,
            softThresholdPct: 99
        })
    }
    const makeAccess = (target: Database) =>
        new RuntimeAccessService(
            target,
            settings as never,
            { event: () => {}, error: () => {} } as never,
            new SandboxActiveDurationService(target),
            undefined,
            period
        )
    const runtimeAccess = makeAccess(db)
    const sent: string[] = []
    const chat = {
        createSession: async () => {
            const [session] = await db
                .insert(chatSessions)
                .values({ id: createObjectId('chatSession'), userId, agentId })
                .returning()
            return session
        },
        sendMessage: async (
            _user: string,
            _agent: string,
            sessionId: string
        ) => {
            const id = randomUUID()
            await db
                .insert(chatMessages)
                .values({
                    id,
                    sessionId,
                    role: 'assistant',
                    contentBlocksJson: []
                })
            sent.push(id)
            return { assistantMessageId: id }
        }
    }
    const scheduler = new AutomationsService(
        db,
        chat as never,
        { get: () => 'false' } as never,
        runtimeAccess
    )
    return {
        userId,
        agentId,
        planId,
        expandedPlanId,
        automationId,
        runtimeAccess,
        sent,
        settings,
        scheduler,
        chat,
        makeAccess,
        tick: () =>
            (scheduler as unknown as { tick: () => Promise<void> }).tick(),
        readAutomation: async () =>
            (
                await db
                    .select()
                    .from(automations)
                    .where(eq(automations.id, automationId))
            )[0],
        close: async () => {
            await db.delete(users).where(eq(users.id, userId))
            await db
                .delete(plans)
                .where(sql`${plans.id} in (${planId}, ${expandedPlanId})`)
        }
    }
}
