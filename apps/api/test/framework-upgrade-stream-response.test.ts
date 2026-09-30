import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ConflictException } from '@nestjs/common'
import {
    AdminRuntimeAgentsController,
    RuntimeAgentsController
} from '../src/modules/agents/runtime-agents.controller'
import type { FrameworkUpgradeEmitter } from '../src/modules/agents/framework-versions/framework-upgrade.service'

const runtime = { id: 'art_1', userId: 'owner', framework: 'hermes' }

// The framework install is the runtime's; both surfaces stream a rebuild the
// same way. The user route takes the caller first, the admin one does not.
const surfaces = [
    {
        name: RuntimeAgentsController.name,
        prototype: RuntimeAgentsController.prototype,
        call: (controller: RuntimeAgentsController, reply: unknown) =>
            controller.upgradeFrameworkStream(
                { userId: 'owner' } as never,
                'art_1',
                { targetVersion: '1.0.0' },
                reply as never
            )
    },
    {
        name: AdminRuntimeAgentsController.name,
        prototype: AdminRuntimeAgentsController.prototype,
        call: (controller: AdminRuntimeAgentsController, reply: unknown) =>
            controller.upgradeFrameworkStream(
                'art_1',
                { targetVersion: '1.0.0' },
                reply as never
            )
    }
] as const

const replyRecorder = () => {
    const events: Array<{ type: string; message?: string; runtime?: unknown }> =
        []
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
                writeHead: (code: number) => {
                    state.status = code
                },
                write: (data: string) => {
                    events.push(JSON.parse(data))
                },
                end: () => {
                    state.ended = true
                }
            }
        }
    }
}

for (const surface of surfaces) {
    const controllerWith = (upgradeStreaming: unknown) =>
        Object.assign(Object.create(surface.prototype), {
            runtimes: {
                findById: async () => runtime,
                toSummary: async (row: { id: string }) => ({ id: row.id })
            },
            frameworkUpgrade: { upgradeStreaming }
        })

    test(`${surface.name} preserves HTTP 409 before starting the upgrade stream`, async () => {
        const controller = controllerWith(async () => {
            throw new ConflictException('upgrade in progress')
        })
        const r = replyRecorder()
        await assert.rejects(
            surface.call(controller, r.reply),
            (err: unknown) =>
                err instanceof ConflictException && err.getStatus() === 409
        )
        assert.equal(r.state.hijacked, false)
    })

    test(`${surface.name} streams execution errors after admission`, async () => {
        const controller = controllerWith(
            async (
                _runtime: unknown,
                _version: string,
                _admin: boolean,
                emitter: FrameworkUpgradeEmitter
            ) => {
                emitter.step('validating')
                throw new Error('install failed')
            }
        )
        const r = replyRecorder()
        await surface.call(controller, r.reply)
        assert.equal(r.state.status, 200)
        assert.deepEqual(
            r.events.map((event) => event.type),
            ['step', 'error']
        )
        assert.equal(r.events[1].message, 'install failed')
        assert.equal(r.state.ended, true)
    })

    test(`${surface.name} completes with the runtime it upgraded`, async () => {
        const controller = controllerWith(
            async (
                owned: { id: string },
                _version: string,
                _admin: boolean,
                emitter: FrameworkUpgradeEmitter
            ) => {
                assert.equal(owned.id, 'art_1')
                emitter.step('verifying')
            }
        )
        const r = replyRecorder()
        await surface.call(controller, r.reply)
        assert.deepEqual(r.events.at(-1), {
            type: 'complete',
            runtime: { id: 'art_1' }
        })
    })
}
