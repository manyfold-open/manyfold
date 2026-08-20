import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException } from '@nestjs/common'
import { automationRuns, automations } from '@manyfold/db'
import { AutomationsService } from '../src/modules/automations/automations.service'

const date = new Date('2026-04-28T09:00:00.000Z')

const automationRow = {
    id: 'automation-1',
    userId: 'user-1',
    agentId: 'agent-1',
    title: 'Standup summary',
    prompt: 'Summarize yesterday git activity.',
    status: 'active',
    schedulePreset: 'daily',
    rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
    timezone: 'UTC',
    dtstart: date,
    model: 'gpt-5.4',
    nextRunAt: date,
    lastRunAt: null,
    deletedAt: null,
    createdAt: date,
    updatedAt: date
}

const agentRow = {
    id: 'agent-1',
    userId: 'user-1',
    name: 'Codex',
    framework: 'codex',
    runtime: 'sprites',
    status: 'running',
    accountId: null,
    clusterId: null,
    runtimeId: 'runtime-1',
    internalId: 'codex',
    model: null,
    extras: {},
    workspacePath: '/workspace',
    spriteName: null,
    spriteId: null,
    mountPath: '/workspace',
    fileRoots: [],
    namespace: null,
    ingressHost: null,
    currentPhase: null,
    failureReason: null,
    startedAt: date,
    lastBootstrappedAt: date,
    lastReconciledAt: date,
    createdAt: date,
    updatedAt: date
}

test('AutomationsService runNow creates a chat session and records the run', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [],
        [{ automation: automationRow, agent: agentRow }],
        [],
        [{ id: 'automation-1' }]
    )
    const chat = new FakeChat()
    let reservedRunUserId: string | null = null
    const service = new AutomationsService(
        db as never,
        chat as never,
        { get: () => 'false' } as never,
        {
            reserveAutomationRun: async (userId: string) => {
                reservedRunUserId = userId
            }
        } as never
    )

    const run = await service.runNow('user-1', 'automation-1')

    assert.equal(reservedRunUserId, 'user-1')
    assert.equal(run.automationId, 'automation-1')
    assert.equal(run.trigger, 'manual')
    assert.equal(run.status, 'running')
    assert.equal(run.chatSessionId, 'session-1')
    assert.equal(run.assistantMessageId, 'assistant-1')
    assert.deepEqual(chat.createdSessions, [
        {
            userId: 'user-1',
            agentId: 'agent-1',
            title: 'Standup summary'
        }
    ])
    assert.deepEqual(chat.sentMessages, [
        {
            userId: 'user-1',
            agentId: 'agent-1',
            sessionId: 'session-1',
            text: 'Summarize yesterday git activity.',
            model: 'gpt-5.4'
        }
    ])
    assert.equal(db.insertedRuns.length, 1)
    assert.ok(
        db.updates.some(
            (update) =>
                update.table === automations &&
                update.set.lastRunAt instanceof Date &&
                update.set.nextRunAt instanceof Date
        )
    )
})

test('AutomationsService tick defers quota-skipped scheduled automation out of the due queue', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [],
        [
            {
                automation: {
                    ...automationRow,
                    nextRunAt: new Date('2026-06-12T09:00:00.000Z')
                },
                agent: agentRow
            }
        ],
        []
    )
    const chat = new FakeChat()
    const reservedRunUserIds: string[] = []
    const service = new AutomationsService(
        db as never,
        chat as never,
        { get: () => 'false' } as never,
        {
            reserveAutomationRun: async (userId: string) => {
                reservedRunUserIds.push(userId)
                throw new ForbiddenException({
                    code: 'AUTOMATION_RUN_QUOTA_REACHED'
                })
            }
        } as never
    )
    const beforeTick = new Date()

    await runSchedulerTick(service)

    const automationUpdates = db.updates.filter(
        (update) => update.table === automations
    )
    assert.deepEqual(reservedRunUserIds, ['user-1'])
    assert.equal(db.insertedRuns.length, 0)
    assert.deepEqual(chat.createdSessions, [])
    assert.equal(automationUpdates.length, 1)
    const patch = automationUpdates[0].set
    assert.equal(patch.lastRunAt, undefined)
    assert.ok(patch.updatedAt instanceof Date)
    const nextRunAt = patch.nextRunAt
    assert.ok(nextRunAt instanceof Date)
    assert.equal(
        nextRunAt.toISOString(),
        nextDailyNineUtcInNextQuotaWindow(beforeTick).toISOString()
    )
})

const runSchedulerTick = (service: AutomationsService): Promise<void> =>
    (service as unknown as { tick: () => Promise<void> }).tick()

const nextDailyNineUtcInNextQuotaWindow = (date: Date): Date =>
    new Date(
        Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth() + 1,
            1,
            9,
            0,
            0,
            0
        )
    )

class FakeChat {
    createdSessions: Array<{
        agentId: string
        title: string | undefined
        userId: string
    }> = []
    sentMessages: Array<{
        agentId: string
        model: string | undefined
        sessionId: string
        text: string | undefined
        userId: string
    }> = []

    async createSession(
        userId: string,
        agentId: string,
        title?: string
    ): Promise<{ id: string }> {
        this.createdSessions.push({ userId, agentId, title })
        return { id: 'session-1' }
    }

    async sendMessage(
        userId: string,
        agentId: string,
        sessionId: string,
        text?: string,
        _attachments: unknown[] = [],
        model?: string
    ): Promise<{ assistantMessageId: string; userMessage: unknown }> {
        this.sentMessages.push({ userId, agentId, sessionId, text, model })
        return { assistantMessageId: 'assistant-1', userMessage: {} }
    }
}

class FakeDb {
    selectResults: unknown[][] = []
    insertedRuns: Array<Record<string, unknown>> = []
    updates: Array<{ table: unknown; set: Record<string, unknown> }> = []
    deletes: unknown[] = []

    select(): FakeQuery {
        return new FakeQuery(this, 'select')
    }

    insert(table: unknown): FakeQuery {
        return new FakeQuery(this, 'insert', table)
    }

    update(table: unknown): FakeQuery {
        return new FakeQuery(this, 'update', table)
    }

    delete(table: unknown): FakeQuery {
        this.deletes.push(table)
        return new FakeQuery(this, 'delete', table)
    }

    nextSelect(): unknown[] {
        return this.selectResults.shift() ?? []
    }
}

class FakeQuery implements PromiseLike<unknown[]> {
    private rowValues: Record<string, unknown> = {}

    constructor(
        private readonly db: FakeDb,
        private readonly kind: 'select' | 'insert' | 'update' | 'delete',
        private readonly table?: unknown
    ) {}

    from(): this {
        return this
    }

    innerJoin(): this {
        return this
    }

    where(): this {
        return this
    }

    orderBy(): this {
        return this
    }

    limit(): this {
        return this
    }

    values(values: Record<string, unknown>): this {
        this.rowValues = values
        return this
    }

    set(patch: Record<string, unknown>): this {
        this.db.updates.push({ table: this.table, set: patch })
        this.rowValues = { ...this.rowValues, ...patch }
        return this
    }

    returning(): Promise<unknown[]> {
        if (this.kind === 'insert' && this.table === automationRuns) {
            const row = {
                ...this.rowValues,
                chatSessionId: null,
                assistantMessageId: null,
                errorMessage: null,
                finishedAt: null,
                createdAt: this.rowValues.createdAt ?? new Date(),
                startedAt: this.rowValues.startedAt ?? new Date()
            }
            this.db.insertedRuns.push(row)
            return Promise.resolve([row])
        }
        if (this.kind === 'update' && this.table === automationRuns) {
            const row = {
                ...this.db.insertedRuns[0],
                ...this.rowValues
            }
            this.db.insertedRuns[0] = row
            return Promise.resolve([row])
        }
        return Promise.resolve([])
    }

    then<TResult1 = unknown[], TResult2 = never>(
        onfulfilled?:
            | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
            | undefined
            | null,
        onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | undefined
            | null
    ): PromiseLike<TResult1 | TResult2> {
        const value =
            this.kind === 'select' ? this.db.nextSelect() : ([] as unknown[])
        return Promise.resolve(value).then(onfulfilled, onrejected)
    }
}

const date2 = new Date('2026-04-28T10:00:00.000Z')

const runningRun = {
    id: 'run-1',
    automationId: 'automation-1',
    userId: 'user-1',
    agentId: 'agent-1',
    trigger: 'scheduled',
    status: 'running',
    chatSessionId: 'session-1',
    assistantMessageId: 'assistant-1',
    errorMessage: null,
    deliveryStatus: null,
    titleSnapshot: 'Standup summary',
    promptSnapshot: 'Summarize yesterday git activity.',
    rruleSnapshot: 'RRULE:FREQ=DAILY',
    modelSnapshot: null,
    startedAt: date2,
    finishedAt: null,
    createdAt: date2
}

const deliveryAutomation = {
    ...automationRow,
    deliveryChannelId: 'chn-1',
    deliveryTarget: { kind: 'chat', id: 'oc_1' }
}

const deliveryChannelRow = {
    id: 'chn-1',
    userId: 'user-1',
    agentId: 'agent-1',
    provider: 'lark',
    label: 'team lark',
    status: 'active'
}

interface BridgeCall {
    channelId: string
    target: unknown
    text: string
}

interface ScopedBridgeCall {
    channelId: string
    scopeKey: string
    text: string
}

const makeDeliveryService = (opts: {
    db: InstanceType<typeof FakeDb>
    outcome?: { state: string; text?: string }
    bridgeStatus?: 'sent' | 'queued' | 'failed'
}): {
    service: AutomationsService
    bridgeCalls: BridgeCall[]
    scopedCalls: ScopedBridgeCall[]
} => {
    const bridgeCalls: BridgeCall[] = []
    const scopedCalls: ScopedBridgeCall[] = []
    const chat = {
        getTurnOutcome: async () =>
            opts.outcome ?? { state: 'done', text: 'All green' }
    }
    const bridge = {
        sendAgentDirect: async (
            channel: { id: string },
            target: unknown,
            text: string
        ) => {
            bridgeCalls.push({ channelId: channel.id, target, text })
            return {
                deliveryId: 1n,
                status: opts.bridgeStatus ?? 'sent',
                providerMessageId: 'om_1'
            }
        },
        sendAgentScoped: async (
            channel: { id: string },
            scopeKey: string,
            text: string
        ) => {
            scopedCalls.push({ channelId: channel.id, scopeKey, text })
            return {
                deliveryId: 1n,
                status: opts.bridgeStatus ?? 'sent',
                providerMessageId: 'om_1'
            }
        }
    }
    const service = new AutomationsService(
        opts.db as never,
        chat as never,
        { get: () => 'false' } as never,
        {
            reserveAutomationRun: async () => {},
            reserveAutomationSlot: async () => {}
        } as never,
        undefined,
        bridge as never
    )
    return { service, bridgeCalls, scopedCalls }
}

test('reconcile delivers a succeeded run through the automation channel', async () => {
    const db = new FakeDb()
    db.insertedRuns.push({ ...runningRun })
    db.selectResults.push(
        [{ run: { ...runningRun }, automation: deliveryAutomation }],
        [{ eventType: 'done', payloadJson: {} }],
        [deliveryChannelRow],
        []
    )
    const { service, bridgeCalls } = makeDeliveryService({ db })

    await service.list('user-1')

    assert.equal(bridgeCalls.length, 1)
    assert.equal(bridgeCalls[0]?.channelId, 'chn-1')
    assert.deepEqual(bridgeCalls[0]?.target, { kind: 'chat', chatId: 'oc_1' })
    assert.match(bridgeCalls[0]?.text ?? '', /^⏰ Standup summary\n\nAll green$/)
    assert.ok(
        db.updates.some(
            (update) =>
                update.table === automationRuns &&
                update.set.deliveryStatus === 'sent'
        )
    )
    // The preview is snapshotted on the terminal flip so run history never has
    // to re-read a transcript that may have been compacted away.
    assert.ok(
        db.updates.some(
            (update) =>
                update.table === automationRuns &&
                update.set.resultPreview === 'All green'
        )
    )
})

test('a [SILENT] reply suppresses delivery but records the outcome', async () => {
    const db = new FakeDb()
    db.insertedRuns.push({ ...runningRun })
    db.selectResults.push(
        [{ run: { ...runningRun }, automation: deliveryAutomation }],
        [{ eventType: 'done', payloadJson: {} }],
        []
    )
    const { service, bridgeCalls } = makeDeliveryService({
        db,
        outcome: { state: 'done', text: '  [SILENT]  ' }
    })

    await service.list('user-1')

    assert.equal(bridgeCalls.length, 0)
    assert.ok(
        db.updates.some(
            (update) =>
                update.table === automationRuns &&
                update.set.deliveryStatus === 'suppressed'
        )
    )
    // A silence token reported nothing, so run history previews nothing.
    assert.ok(
        db.updates.some(
            (update) =>
                update.table === automationRuns &&
                update.set.status === 'succeeded' &&
                update.set.resultPreview === null
        )
    )
})

test('a failed run delivers the failure note', async () => {
    const db = new FakeDb()
    db.insertedRuns.push({ ...runningRun })
    db.selectResults.push(
        [{ run: { ...runningRun }, automation: deliveryAutomation }],
        [
            {
                eventType: 'error',
                payloadJson: { error: { message: 'boom' } }
            }
        ],
        [deliveryChannelRow],
        []
    )
    const { service, bridgeCalls } = makeDeliveryService({ db })

    await service.list('user-1')

    assert.equal(bridgeCalls.length, 1)
    assert.match(bridgeCalls[0]?.text ?? '', /run failed: boom/)
    // A failed run has no answer to preview; the error message carries it.
    assert.ok(
        db.updates.some(
            (update) =>
                update.table === automationRuns &&
                update.set.status === 'failed' &&
                update.set.resultPreview === null
        )
    )
})

test('list reports the latest run status so a list row can show a failure', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        // reconcileRunning finds nothing in flight
        [],
        [
            {
                automation: automationRow,
                agent: agentRow,
                lastRunStatus: 'failed'
            }
        ]
    )
    const { service } = makeDeliveryService({ db })

    const [summary] = await service.list('user-1')

    assert.equal(summary?.id, 'automation-1')
    assert.equal(summary?.lastRunStatus, 'failed')
})

test('an automation that never ran reports no last run status', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [],
        [{ automation: automationRow, agent: agentRow, lastRunStatus: null }]
    )
    const { service } = makeDeliveryService({ db })

    const [summary] = await service.list('user-1')

    assert.equal(summary?.lastRunStatus, null)
})

test('runs without delivery config skip the channel entirely', async () => {
    const db = new FakeDb()
    db.insertedRuns.push({ ...runningRun })
    db.selectResults.push(
        [{ run: { ...runningRun }, automation: automationRow }],
        [{ eventType: 'done', payloadJson: {} }],
        []
    )
    const { service, bridgeCalls } = makeDeliveryService({ db })

    await service.list('user-1')

    assert.equal(bridgeCalls.length, 0)
    assert.ok(
        !db.updates.some(
            (update) => update.set.deliveryStatus !== undefined
        )
    )
})

test('create rejects a delivery channel bound to a different agent', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [agentRow],
        [{ ...deliveryChannelRow, agentId: 'agent-other' }]
    )
    const { service } = makeDeliveryService({ db })

    await assert.rejects(
        service.create('user-1', {
            agentId: 'agent-1',
            title: 'Report',
            prompt: 'do it',
            schedulePreset: 'daily',
            rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
            timezone: 'UTC',
            deliveryChannelId: 'chn-1',
            deliveryTarget: { kind: 'chat', id: 'oc_1' }
        }),
        /must be bound to the automation agent/
    )
})

test('create rejects a half-configured delivery pair', async () => {
    const db = new FakeDb()
    db.selectResults.push([agentRow])
    const { service } = makeDeliveryService({ db })

    await assert.rejects(
        service.create('user-1', {
            agentId: 'agent-1',
            title: 'Report',
            prompt: 'do it',
            schedulePreset: 'daily',
            rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
            timezone: 'UTC',
            deliveryChannelId: 'chn-1'
        }),
        /must be set together/
    )
})

// Scope targets deliver into an existing conversation via the provider's
// sendText, so they must work on providers without sendDirect — that is the
// whole point of the scope kind (Discord/Slack automation delivery).
const discordChannelRow = {
    ...deliveryChannelRow,
    provider: 'discord',
    label: 'team discord'
}

const scopeKey = 'discord:guild:g1:channel:c1'

const scopeAutomation = {
    ...automationRow,
    deliveryChannelId: 'chn-1',
    deliveryTarget: { kind: 'scope', scopeKey }
}

const activeSessionRow = {
    id: 'chs-1',
    channelId: 'chn-1',
    scopeKey,
    isActive: true,
    archivedAt: null
}

const createBody = {
    agentId: 'agent-1',
    title: 'Report',
    prompt: 'do it',
    schedulePreset: 'daily' as const,
    rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
    timezone: 'UTC'
}

test('create accepts a scope target on a sendDirect-less provider with a live conversation', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [agentRow],
        [discordChannelRow],
        [activeSessionRow],
        [],
        [{ automation: scopeAutomation, agent: agentRow }],
        []
    )
    const { service } = makeDeliveryService({ db })

    const detail = await service.create('user-1', {
        ...createBody,
        deliveryChannelId: 'chn-1',
        deliveryTarget: { kind: 'scope', scopeKey }
    })

    assert.deepEqual(detail.deliveryTarget, { kind: 'scope', scopeKey })
})

test('create rejects a scope target without an active conversation', async () => {
    const db = new FakeDb()
    db.selectResults.push([agentRow], [discordChannelRow], [])
    const { service } = makeDeliveryService({ db })

    await assert.rejects(
        service.create('user-1', {
            ...createBody,
            deliveryChannelId: 'chn-1',
            deliveryTarget: { kind: 'scope', scopeKey }
        }),
        /no active conversation/
    )
})

test('create still rejects chat/user targets on sendDirect-less providers', async () => {
    const db = new FakeDb()
    db.selectResults.push([agentRow], [discordChannelRow])
    const { service } = makeDeliveryService({ db })

    await assert.rejects(
        service.create('user-1', {
            ...createBody,
            deliveryChannelId: 'chn-1',
            deliveryTarget: { kind: 'chat', id: 'c1' }
        }),
        /do not support agent send/
    )
})

test('reconcile delivers a scope target through sendAgentScoped', async () => {
    const db = new FakeDb()
    db.insertedRuns.push({ ...runningRun })
    db.selectResults.push(
        [{ run: { ...runningRun }, automation: scopeAutomation }],
        [{ eventType: 'done', payloadJson: {} }],
        [discordChannelRow],
        []
    )
    const { service, bridgeCalls, scopedCalls } = makeDeliveryService({ db })

    await service.list('user-1')

    assert.equal(bridgeCalls.length, 0)
    assert.equal(scopedCalls.length, 1)
    assert.equal(scopedCalls[0]?.channelId, 'chn-1')
    assert.equal(scopedCalls[0]?.scopeKey, scopeKey)
    assert.match(scopedCalls[0]?.text ?? '', /^⏰ Standup summary\n\nAll green$/)
    assert.ok(
        db.updates.some(
            (update) =>
                update.table === automationRuns &&
                update.set.deliveryStatus === 'sent'
        )
    )
})

test('a [SILENT] reply suppresses scope delivery too', async () => {
    const db = new FakeDb()
    db.insertedRuns.push({ ...runningRun })
    db.selectResults.push(
        [{ run: { ...runningRun }, automation: scopeAutomation }],
        [{ eventType: 'done', payloadJson: {} }],
        []
    )
    const { service, scopedCalls } = makeDeliveryService({
        db,
        outcome: { state: 'done', text: '[SILENT]' }
    })

    await service.list('user-1')

    assert.equal(scopedCalls.length, 0)
    assert.ok(
        db.updates.some(
            (update) =>
                update.table === automationRuns &&
                update.set.deliveryStatus === 'suppressed'
        )
    )
})

// Session liveness is volatile (archival, rebind): an update that leaves the
// delivery config unchanged must not re-verify it, or pause/title PATCHes
// start failing the moment the conversation goes inactive.
test('an unrelated update keeps a scope target whose conversation went inactive', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [{ automation: scopeAutomation, agent: agentRow }],
        [discordChannelRow],
        [],
        [{ automation: { ...scopeAutomation, title: 'Renamed' }, agent: agentRow }],
        []
    )
    const { service } = makeDeliveryService({ db })

    const detail = await service.update('user-1', 'automation-1', {
        title: 'Renamed'
    })

    assert.equal(detail.title, 'Renamed')
    assert.deepEqual(detail.deliveryTarget, { kind: 'scope', scopeKey })
    assert.ok(
        db.updates.some(
            (update) =>
                update.table === automations && update.set.title === 'Renamed'
        )
    )
})

// #588 two-phase deletion: delete/removeManaged write a tombstone, never a
// physical DELETE — the retention sweep owns the hard delete.
test('delete tombstones the automation instead of hard-deleting it', async () => {
    const db = new FakeDb()
    db.selectResults.push([{ automation: automationRow, agent: agentRow }])
    const { service } = makeDeliveryService({ db })

    await service.delete('user-1', 'automation-1')

    assert.equal(db.deletes.length, 0)
    const tombstone = db.updates.find(
        (update) => update.table === automations
    )
    assert.ok(tombstone)
    assert.ok(tombstone.set.deletedAt instanceof Date)
    assert.equal(tombstone.set.nextRunAt, null)
})

test('removeManaged tombstones the mirror instead of hard-deleting it', async () => {
    const db = new FakeDb()
    const { service } = makeDeliveryService({ db })

    await service.removeManaged('automation-1')

    assert.equal(db.deletes.length, 0)
    const tombstone = db.updates.find(
        (update) => update.table === automations
    )
    assert.ok(tombstone)
    assert.ok(tombstone.set.deletedAt instanceof Date)
    assert.equal(tombstone.set.nextRunAt, null)
})

test('a delete landing before dispatch fails the run instead of executing it', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [],
        [{ automation: automationRow, agent: agentRow }],
        [],
        []
    )
    const chat = new FakeChat()
    const service = new AutomationsService(
        db as never,
        chat as never,
        { get: () => 'false' } as never,
        { reserveAutomationRun: async () => {} } as never
    )

    await assert.rejects(
        service.runNow('user-1', 'automation-1'),
        /automation was deleted/
    )

    assert.deepEqual(chat.createdSessions, [])
    assert.deepEqual(chat.sentMessages, [])
    assert.ok(
        db.updates.some(
            (update) =>
                update.table === automationRuns &&
                update.set.status === 'failed' &&
                update.set.errorMessage === 'automation was deleted'
        )
    )
})

test('reconcile finalizes a tombstoned automation run but skips delivery', async () => {
    const db = new FakeDb()
    db.insertedRuns.push({ ...runningRun })
    db.selectResults.push(
        [
            {
                run: { ...runningRun },
                automation: { ...deliveryAutomation, deletedAt: date2 }
            }
        ],
        [{ eventType: 'done', payloadJson: {} }],
        []
    )
    const { service, bridgeCalls, scopedCalls } = makeDeliveryService({ db })

    await service.list('user-1')

    assert.equal(bridgeCalls.length, 0)
    assert.equal(scopedCalls.length, 0)
    assert.ok(
        db.updates.some(
            (update) =>
                update.table === automationRuns &&
                update.set.status === 'succeeded'
        )
    )
    assert.ok(
        !db.updates.some(
            (update) => update.set.deliveryStatus !== undefined
        )
    )
})

test('changing the delivery target re-verifies scope liveness', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [{ automation: scopeAutomation, agent: agentRow }],
        [discordChannelRow],
        []
    )
    const { service } = makeDeliveryService({ db })

    await assert.rejects(
        service.update('user-1', 'automation-1', {
            deliveryChannelId: 'chn-1',
            deliveryTarget: { kind: 'scope', scopeKey: 'discord:dm:user:u9' }
        }),
        /no active conversation/
    )
})
