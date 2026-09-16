import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ConflictException } from '@nestjs/common'
import { AgentsController } from '../src/modules/agents/agents.controller'
import { AdminAgentsController } from '../src/modules/agents/admin-agents.controller'
import type { FrameworkUpgradeEmitter } from '../src/modules/agents/framework-versions/framework-upgrade.service'

for (const Controller of [AgentsController, AdminAgentsController]) {
    test(`${Controller.name} preserves HTTP 409 before starting the upgrade stream`, async () => {
        const controller = Object.assign(Object.create(Controller.prototype), {
            frameworkUpgrade: {
                upgradeStreaming: async () => {
                    throw new ConflictException('upgrade in progress')
                }
            }
        })
        let touched = false
        const reply = {
            hijack: () => {
                touched = true
            }
        }
        await assert.rejects(
            controller.upgradeFrameworkStream(
                { userId: 'owner' },
                'agent',
                { targetVersion: '1.0.0' },
                reply
            ),
            (err: unknown) =>
                err instanceof ConflictException && err.getStatus() === 409
        )
        assert.equal(touched, false)
    })

    test(`${Controller.name} streams execution errors after admission`, async () => {
        const controller = Object.assign(Object.create(Controller.prototype), {
            frameworkUpgrade: {
                upgradeStreaming: async (
                    _id: string,
                    _user: string,
                    _version: string,
                    _admin: boolean,
                    emitter: FrameworkUpgradeEmitter
                ) => {
                    emitter.step('validating')
                    throw new Error('install failed')
                }
            }
        })
        const events: Array<{ type: string; message?: string }> = []
        let status = 0
        let ended = false
        const reply = {
            hijack: () => {},
            request: { headers: {} },
            raw: {
                writeHead: (code: number) => {
                    status = code
                },
                write: (data: string) => {
                    events.push(JSON.parse(data))
                },
                end: () => {
                    ended = true
                }
            }
        }
        await controller.upgradeFrameworkStream(
            { userId: 'owner' },
            'agent',
            { targetVersion: '1.0.0' },
            reply
        )
        assert.equal(status, 200)
        assert.deepEqual(
            events.map((event) => event.type),
            ['step', 'error']
        )
        assert.equal(events[1].message, 'install failed')
        assert.equal(ended, true)
    })
}
