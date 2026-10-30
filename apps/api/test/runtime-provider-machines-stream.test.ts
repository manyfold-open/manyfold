import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException, ConflictException } from '@nestjs/common'
import { RuntimeProviderMachinesController } from '../src/modules/runtime-providers/runtime-provider-machines.controller'
import type { UpgradeEvents } from '../src/modules/runtime-providers/runtime-provider-machines.service'

// An upgrade streams NDJSON from the moment the provider accepts it; before
// that it is an ordinary request, so a refusal keeps its HTTP status.

const replyRecorder = (opts: { gone?: boolean } = {}) => {
    const events: Array<Record<string, unknown>> = []
    const state = { status: 0, ended: false, hijacked: false }
    return {
        events,
        state,
        reply: {
            hijack: () => {
                state.hijacked = true
            },
            request: { headers: {} },
            raw: {
                destroyed: opts.gone === true,
                writableEnded: false,
                writeHead: (code: number) => {
                    state.status = code
                },
                write: (data: string) => {
                    if (data.trim()) events.push(JSON.parse(data))
                },
                end: () => {
                    state.ended = true
                }
            }
        }
    }
}

const controllerWith = (
    upgrade: (
        actor: string,
        id: string,
        name: string,
        body: unknown,
        events: UpgradeEvents
    ) => Promise<unknown>
) =>
    Object.assign(Object.create(RuntimeProviderMachinesController.prototype), {
        machines: { upgrade }
    }) as RuntimeProviderMachinesController

const run = (
    controller: RuntimeProviderMachinesController,
    reply: unknown,
    name = 'sbx-a'
) =>
    controller.upgrade(
        { userId: 'admin' } as never,
        'rtp_1',
        name,
        { allowStorageMigration: true },
        reply as never
    )

const result = {
    outcome: 'completed',
    message: 'Upgrade complete',
    fromVersion: '0.0.1-rc44',
    targetVersion: '0.0.2',
    lastStep: 'completed'
}

test('a refusal before the provider accepts stays a plain HTTP error', async () => {
    const r = replyRecorder()
    const controller = controllerWith(async () => {
        throw new ConflictException({
            message: 'this upgrade would move the sprite',
            code: 'PROVIDER_MACHINE_STORAGE_MIGRATION_REQUIRED'
        })
    })
    await assert.rejects(run(controller, r.reply), ConflictException)
    assert.equal(r.state.hijacked, false)
    assert.deepEqual(r.events, [])
})

test('an accepted upgrade streams its start, its steps and its result', async () => {
    const r = replyRecorder()
    const controller = controllerWith(async (_a, _i, _n, _b, events) => {
        events.onAccepted?.('0.0.1-rc44')
        events.onStep?.('starting_machine')
        return result
    })
    await run(controller, r.reply)
    assert.equal(r.state.hijacked, true)
    assert.equal(r.state.status, 200)
    assert.deepEqual(r.events, [
        { type: 'accepted', fromVersion: '0.0.1-rc44' },
        { type: 'step', step: 'starting_machine' },
        { type: 'complete', result }
    ])
    assert.equal(r.state.ended, true)
})

test('a failure after the start is an error event, and the stream ends', async () => {
    const r = replyRecorder()
    const controller = controllerWith(async (_a, _i, _n, _b, events) => {
        events.onAccepted?.(null)
        throw new ConflictException({ message: 'gone', code: 'X_GONE' })
    })
    await run(controller, r.reply)
    assert.deepEqual(r.events.at(-1), {
        type: 'error',
        code: 'X_GONE',
        status: 409,
        message: 'gone'
    })
    assert.equal(r.state.ended, true)
})

test('an admin who left is not written to, and the upgrade still runs to its end', async () => {
    const r = replyRecorder({ gone: true })
    let finished = false
    const controller = controllerWith(async (_a, _i, _n, _b, events) => {
        events.onAccepted?.('0.0.1-rc44')
        events.onStep?.('starting_machine')
        finished = true
        return result
    })
    await run(controller, r.reply)
    assert.equal(finished, true)
    assert.deepEqual(r.events, [])
})

test('a name that is not a machine name never reaches the provider', async () => {
    const r = replyRecorder()
    let called = false
    const controller = controllerWith(async () => {
        called = true
        return result
    })
    await assert.rejects(
        run(controller, r.reply, '../sprites'),
        BadRequestException
    )
    assert.equal(called, false)
})
