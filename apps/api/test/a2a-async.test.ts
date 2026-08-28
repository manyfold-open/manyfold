import test from 'node:test'
import assert from 'node:assert/strict'
import { A2aService } from '../src/modules/a2a/a2a.service'
import { A2aSelfController } from '../src/modules/a2a/a2a-self.controller'

// writeAudit is best-effort; a no-op insert keeps it from throwing.
const dbFake = { insert: () => ({ values: async () => {} }) } as never

interface UpdateCall {
    id: string
    patch: Record<string, unknown>
}

// A tasks repository fake that captures update() calls and keeps one created
// row coherent so toWireTask() and the detached terminal write see real state.
const makeTasksFake = () => {
    const updates: UpdateCall[] = []
    let created: Record<string, unknown> | undefined
    const fake = {
        create: async (input: Record<string, unknown>) => {
            created = {
                ...input,
                state: 'submitted',
                artifactJson: null,
                errorJson: null,
                usageJson: null,
                userMessageId: null,
                assistantMessageId: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                completedAt: null
            }
            return created
        },
        findById: async () => created ?? null,
        findByContext: async () => null,
        findByClientMessage: async () => null,
        countInflightForUser: async () => 0,
        update: async (id: string, patch: Record<string, unknown>) => {
            updates.push({ id, patch })
            if (created && created.id === id) Object.assign(created, patch)
        },
        updateIfActive: async (id: string, patch: Record<string, unknown>) => {
            const terminal = ['completed', 'failed', 'canceled', 'rejected']
            if (!created || created.id !== id) return false
            if (terminal.includes(created.state as string)) return false
            updates.push({ id, patch })
            Object.assign(created, patch)
            return true
        },
        listStaleInflight: async () => [],
        listForOwner: async () => []
    }
    return { fake, updates }
}

// A ChatService fake that drives one successful turn through the observer.
const makeChatFake = (onTurn?: () => void) => ({
    createSession: async () => ({ id: 'cs_1' }),
    sendMessage: async (...args: unknown[]) => {
        const observer = args[args.length - 1] as
            | ((e: Record<string, unknown>) => void)
            | undefined
        observer?.({ type: 'token', text: 'hello' })
        observer?.({ type: 'done' })
        onTurn?.()
        return { userMessage: { id: 'um_1' }, assistantMessageId: 'am_1' }
    }
})

const ctx = {
    userId: 'u1',
    targetAgentId: 'agt_t',
    callerAgentId: 'agt_c',
    externalSubject: null
} as never

const sendParams = (messageId: string, blocking?: boolean) =>
    ({
        message: {
            kind: 'message',
            role: 'user',
            parts: [{ kind: 'text', text: 'hi' }],
            messageId
        },
        ...(blocking === undefined ? {} : { configuration: { blocking } })
    }) as never

test('message/send blocking:false returns working at once, finishes detached', async () => {
    const { fake: tasks, updates } = makeTasksFake()
    let turnRan = false
    const chat = makeChatFake(() => {
        turnRan = true
    })
    const svc = new A2aService(dbFake, chat as never, tasks as never)

    const task = await svc.sendMessage(ctx, sendParams('m1', false))
    assert.equal(task.kind, 'task')
    assert.equal(task.status.state, 'working')

    // The detached turn settles after the synchronous return.
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(turnRan, true)
    const last = updates[updates.length - 1]
    assert.equal(last.patch.state, 'completed')
})

test('message/send blocking (default) returns the completed task with artifact', async () => {
    const { fake: tasks } = makeTasksFake()
    const svc = new A2aService(dbFake, makeChatFake() as never, tasks as never)

    const task = await svc.sendMessage(ctx, sendParams('m2'))
    assert.equal(task.status.state, 'completed')
    assert.equal(task.artifacts?.[0]?.parts[0]?.kind, 'text')
    assert.equal(
        (task.artifacts?.[0]?.parts[0] as { text: string }).text,
        'hello'
    )
})

test('stale sweep force-fails orphaned non-terminal tasks as orphaned', async () => {
    const updates: UpdateCall[] = []
    const tasks = {
        listStaleInflight: async () => [{ id: 'aat_x', state: 'working' }],
        updateIfActive: async (id: string, patch: Record<string, unknown>) => {
            updates.push({ id, patch })
            return true
        }
    }
    const svc = new A2aService(dbFake, {} as never, tasks as never)

    await (svc as unknown as { sweepStaleTasks: () => Promise<void> })
        .sweepStaleTasks()

    assert.equal(updates.length, 1)
    assert.equal(updates[0].id, 'aat_x')
    assert.equal(updates[0].patch.state, 'failed')
    assert.equal(
        (updates[0].patch.errorJson as { code: string }).code,
        'orphaned'
    )
})

test('stale sweep does NOT clobber a task that completed mid-sweep', async () => {
    const updates: UpdateCall[] = []
    const tasks = {
        listStaleInflight: async () => [{ id: 'aat_x', state: 'working' }],
        // Simulate the row having reached a terminal state between select+update.
        updateIfActive: async (id: string, patch: Record<string, unknown>) => {
            updates.push({ id, patch })
            return false
        }
    }
    const svc = new A2aService(dbFake, {} as never, tasks as never)
    await (svc as unknown as { sweepStaleTasks: () => Promise<void> })
        .sweepStaleTasks()
    // It attempted the conditional update but it no-opped (returned false), so
    // nothing was clobbered — the completed result/state survives.
    assert.equal(updates.length, 1)
})

test('cancelTask durably marks the task canceled and aborts the turn', async () => {
    let aborted = false
    const tasks = {
        findById: async () => ({
            id: 'aat_c',
            state: 'working',
            assistantMessageId: 'am_1',
            targetAgentId: 'agt_t',
            callerAgentId: 'agt_c',
            externalSubject: null,
            contextId: 'aac_1',
            artifactJson: null,
            errorJson: null,
            updatedAt: new Date()
        }),
        updateIfActive: async (_id: string, patch: Record<string, unknown>) =>
            patch.state === 'canceled'
    }
    const chat = {
        cancelMessage: async () => {
            aborted = true
        }
    }
    const svc = new A2aService(dbFake, chat as never, tasks as never)
    const task = await svc.cancelTask(ctx, 'aat_c')
    assert.equal(task.status.state, 'canceled')
    assert.equal(aborted, true)
})

// ---- per-mode timeout caps (#211) ----

const makeTelemetryFake = () => {
    const events: { name: string; attrs: Record<string, unknown> }[] = []
    return {
        fake: {
            event: (name: string, attrs: Record<string, unknown>) => {
                events.push({ name, attrs })
            },
            error: (
                name: string,
                _err: Error,
                attrs: Record<string, unknown>
            ) => {
                events.push({ name, attrs })
            }
        },
        events
    }
}

// Bypasses normalize, so fractional "seconds" give fast sub-second test caps.
const settingsFake = (
    override: {
        blockingTimeoutSeconds: number
        asyncTimeoutSeconds: number
    } | null
) => ({
    getCachedA2aTurnTimeoutsOverride: async () => override
})

// A ChatService fake whose turn never finishes (observer never emits done),
// with a cancelMessage recorder for the timeout-cancel assertion.
const makeStuckChatFake = () => {
    const state = { cancelled: false }
    return {
        state,
        fake: {
            createSession: async () => ({ id: 'cs_1' }),
            sendMessage: async () => ({
                userMessage: { id: 'um_1' },
                assistantMessageId: 'am_1'
            }),
            cancelMessage: async () => {
                state.cancelled = true
            }
        }
    }
}

test('blocking send fails with turn_timeout at the blocking cap and cancels the turn', async () => {
    const { fake: tasks, updates } = makeTasksFake()
    const { fake: chat, state } = makeStuckChatFake()
    const { fake: telemetry, events } = makeTelemetryFake()
    const svc = new A2aService(
        dbFake,
        chat as never,
        tasks as never,
        undefined,
        settingsFake({
            blockingTimeoutSeconds: 0.05,
            asyncTimeoutSeconds: 10
        }) as never,
        telemetry as never
    )

    const task = await svc.sendMessage(ctx, sendParams('m3'))
    assert.equal(task.status.state, 'failed')
    const last = updates[updates.length - 1]
    assert.equal(last.patch.state, 'failed')
    const errorJson = last.patch.errorJson as { message: string; code: string }
    assert.equal(errorJson.code, 'turn_timeout')
    assert.match(errorJson.message, /blocking cap/)
    assert.equal(state.cancelled, true)
    const timeoutEvent = events.find((e) => e.name === 'a2a.turn.timeout')
    assert.ok(timeoutEvent, 'expected a2a.turn.timeout telemetry')
    assert.equal(timeoutEvent.attrs.mode, 'blocking')
    assert.equal(timeoutEvent.attrs.taskId, task.id)
    assert.equal(timeoutEvent.attrs.timeoutMs, 50)
    assert.equal(typeof timeoutEvent.attrs.durationMs, 'number')
})

test('detached turn uses the async cap, not the blocking cap', async () => {
    const { fake: tasks, updates } = makeTasksFake()
    const chat = {
        createSession: async () => ({ id: 'cs_1' }),
        sendMessage: async (...args: unknown[]) => {
            const observer = args[args.length - 1] as
                | ((e: Record<string, unknown>) => void)
                | undefined
            setTimeout(() => {
                observer?.({ type: 'token', text: 'hi' })
                observer?.({ type: 'done' })
            }, 100)
            return { userMessage: { id: 'um_1' }, assistantMessageId: 'am_1' }
        },
        cancelMessage: async () => {}
    }
    const { fake: telemetry, events } = makeTelemetryFake()
    const svc = new A2aService(
        dbFake,
        chat as never,
        tasks as never,
        undefined,
        settingsFake({
            blockingTimeoutSeconds: 0.05,
            asyncTimeoutSeconds: 5
        }) as never,
        telemetry as never
    )

    const task = await svc.sendMessage(ctx, sendParams('m4', false))
    assert.equal(task.status.state, 'working')
    await new Promise((r) => setTimeout(r, 300))
    // The 50ms blocking cap must not have fired for the detached turn.
    const last = updates[updates.length - 1]
    assert.equal(last.patch.state, 'completed')
    assert.equal(
        events.some((e) => e.name === 'a2a.turn.timeout'),
        false
    )
    const complete = events.find((e) => e.name === 'a2a.turn.complete')
    assert.ok(complete, 'expected a2a.turn.complete telemetry')
    assert.equal(complete.attrs.mode, 'detached')
})

test('detached turn past the async cap fails with turn_timeout (detached cap)', async () => {
    const { fake: tasks, updates } = makeTasksFake()
    const { fake: chat, state } = makeStuckChatFake()
    const { fake: telemetry, events } = makeTelemetryFake()
    const svc = new A2aService(
        dbFake,
        chat as never,
        tasks as never,
        undefined,
        settingsFake({
            blockingTimeoutSeconds: 0.05,
            asyncTimeoutSeconds: 0.08
        }) as never,
        telemetry as never
    )

    const task = await svc.sendMessage(ctx, sendParams('m5', false))
    assert.equal(task.status.state, 'working')
    await new Promise((r) => setTimeout(r, 250))
    const last = updates[updates.length - 1]
    assert.equal(last.patch.state, 'failed')
    const errorJson = last.patch.errorJson as { message: string; code: string }
    assert.equal(errorJson.code, 'turn_timeout')
    assert.match(errorJson.message, /detached cap/)
    assert.equal(state.cancelled, true)
    const timeoutEvent = events.find((e) => e.name === 'a2a.turn.timeout')
    assert.ok(timeoutEvent, 'expected a2a.turn.timeout telemetry')
    assert.equal(timeoutEvent.attrs.mode, 'detached')
})

test('stale sweep window spans the largest cap plus grace', async () => {
    let olderThan: Date | null = null
    const tasks = {
        listStaleInflight: async (arg: Date) => {
            olderThan = arg
            return []
        }
    }
    const svc = new A2aService(
        dbFake,
        {} as never,
        tasks as never,
        undefined,
        settingsFake({
            blockingTimeoutSeconds: 600,
            asyncTimeoutSeconds: 7200
        }) as never
    )

    const before = Date.now()
    await (
        svc as unknown as { sweepStaleTasks: () => Promise<void> }
    ).sweepStaleTasks()

    assert.ok(olderThan, 'expected listStaleInflight to be queried')
    const windowMs = before - (olderThan as Date).getTime()
    // async cap (7200s) + grace (60s), not the blocking cap
    assert.ok(
        Math.abs(windowMs - 7_260_000) < 1_000,
        `sweep window was ${windowMs}ms`
    )
})

test('resolveTurnTimeouts precedence: admin setting > defaults, env is dead', async () => {
    type Resolver = {
        resolveTurnTimeouts: () => Promise<{
            blockingMs: number
            asyncMs: number
        }>
    }
    const envConfig = {
        get: (k: string) => (k === 'A2A_TURN_TIMEOUT_MS' ? '123000' : undefined)
    }

    const withOverride = new A2aService(
        dbFake,
        {} as never,
        {} as never,
        envConfig as never,
        settingsFake({
            blockingTimeoutSeconds: 60,
            asyncTimeoutSeconds: 120
        }) as never
    )
    assert.deepEqual(
        await (withOverride as unknown as Resolver).resolveTurnTimeouts(),
        { blockingMs: 60_000, asyncMs: 120_000 }
    )

    // Retirement pin: a still-set A2A_TURN_TIMEOUT_MS must be ignored — the
    // startup migration owns it now (A2aTimeoutEnvMigrationService), and the
    // resolver falls straight from the absent setting to the defaults.
    const withDeadEnv = new A2aService(
        dbFake,
        {} as never,
        {} as never,
        envConfig as never,
        settingsFake(null) as never
    )
    assert.deepEqual(
        await (withDeadEnv as unknown as Resolver).resolveTurnTimeouts(),
        { blockingMs: 600_000, asyncMs: 7_200_000 }
    )

    const bare = new A2aService(dbFake, {} as never, {} as never)
    assert.deepEqual(
        await (bare as unknown as Resolver).resolveTurnTimeouts(),
        { blockingMs: 600_000, asyncMs: 7_200_000 }
    )
})

test('cancelTask emits a2a.task.canceled telemetry with duration', async () => {
    const createdAt = new Date(Date.now() - 5_000)
    const tasks = {
        findById: async () => ({
            id: 'aat_tel',
            state: 'working',
            assistantMessageId: 'am_1',
            targetAgentId: 'agt_t',
            callerAgentId: 'agt_c',
            externalSubject: null,
            contextId: 'aac_1',
            artifactJson: null,
            errorJson: null,
            createdAt,
            updatedAt: new Date()
        }),
        updateIfActive: async (_id: string, patch: Record<string, unknown>) =>
            patch.state === 'canceled'
    }
    const chat = { cancelMessage: async () => {} }
    const { fake: telemetry, events } = makeTelemetryFake()
    const svc = new A2aService(
        dbFake,
        chat as never,
        tasks as never,
        undefined,
        undefined,
        telemetry as never
    )

    await svc.cancelTask(ctx, 'aat_tel')
    const canceled = events.find((e) => e.name === 'a2a.task.canceled')
    assert.ok(canceled, 'expected a2a.task.canceled telemetry')
    assert.equal(canceled.attrs.taskId, 'aat_tel')
    assert.equal(canceled.attrs.targetAgentId, 'agt_t')
    assert.equal(canceled.attrs.callerAgentId, 'agt_c')
    assert.ok((canceled.attrs.durationMs as number) >= 5_000)
})

const humanUser = {
    kind: 'human-api-token',
    userId: 'u1',
    tokenId: 'pat',
    scopes: ['a2a:read']
} as never

const agentUser = {
    kind: 'agent-runtime',
    userId: 'u1',
    agentId: 'agt_c',
    runtimeTokenId: 'rt1'
} as never

// Build the self controller with a fake A2aService capturing listAgentTasks and
// an assertOwner that only succeeds for `owned` agents (mirrors the DB gate).
const makeSelfController = (owned: string[] = []) => {
    const calls: {
        userId: string
        agentId: string
        opts: Record<string, unknown>
    }[] = []
    const a2a = {
        listAgentTasks: async (
            userId: string,
            agentId: string,
            opts: Record<string, unknown>
        ) => {
            calls.push({ userId, agentId, opts })
            return { tasks: [], nextCursor: null }
        },
        assertOwner: async (agentId: string) => {
            if (!owned.includes(agentId)) throw new Error('agent not found')
        }
    }
    return { controller: new A2aSelfController({} as never, a2a as never), calls }
}

test('agent-self tasks lists only this agent outbound, scoped to its owner', async () => {
    const { controller, calls } = makeSelfController()
    await controller.tasks(agentUser, 'working', undefined, undefined, undefined)
    assert.equal(calls[0].userId, 'u1')
    assert.equal(calls[0].agentId, 'agt_c')
    assert.equal(calls[0].opts.direction, 'outbound')
    assert.equal(calls[0].opts.state, 'working')
})

test('human token with --agent-id (owned) acts as that agent', async () => {
    const { controller, calls } = makeSelfController(['agt_owned'])
    await controller.tasks(humanUser, undefined, undefined, undefined, 'agt_owned')
    assert.equal(calls[0].userId, 'u1')
    assert.equal(calls[0].agentId, 'agt_owned')
})

test('human token without --agent-id is rejected (needs agent context)', async () => {
    const { controller } = makeSelfController()
    await assert.rejects(
        () => controller.tasks(humanUser, undefined, undefined, undefined, undefined),
        /agent context/
    )
})

test('human token cannot act as an agent it does not own', async () => {
    const { controller } = makeSelfController(['agt_mine'])
    await assert.rejects(
        () =>
            controller.tasks(humanUser, undefined, undefined, undefined, 'agt_other'),
        /agent not found/
    )
})

test('agent runtime token ignores --agent-id, uses its bound identity', async () => {
    const { controller, calls } = makeSelfController(['agt_other'])
    await controller.tasks(agentUser, undefined, undefined, undefined, 'agt_other')
    assert.equal(calls[0].agentId, 'agt_c')
})
