import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException, ConflictException } from '@nestjs/common'
import { AgentsController } from '../src/modules/agents/agents.controller'
import {
    DAEMON_CONFIG_REQUEST_WAIT_MS,
    DaemonConfigDeliveryError
} from '../src/modules/daemon/daemon-config-delivery.service'

// POST /agents/:id/mcp/materialize waits for a machine another push holds,
// and when that push outlasts the wait, says so with a code a client can
// retry on.

const controllerWith = (
    materialize: () => Promise<unknown>
): { controller: AgentsController; calls: unknown[] } => {
    const calls: unknown[] = []
    const deps: unknown[] = Array.from({ length: 14 }, () => ({}))
    deps[0] = {
        findForCaller: async () => ({ id: 'agt_1' }),
        get: async () => ({ id: 'agt_1' })
    }
    deps[9] = {
        materializeForAgent: async (_agent: unknown, options: unknown) => {
            calls.push(options)
            return materialize()
        }
    }
    const Controller = AgentsController as unknown as new (
        ...args: unknown[]
    ) => AgentsController
    return { controller: new Controller(...deps), calls }
}

const user = { userId: 'usr_1' } as never

test('an explicit push waits for a held machine; one still held is a coded 409', async () => {
    const ok = controllerWith(async () => [
        { scopeId: 'user', status: 'delivered' }
    ])
    const res = await ok.controller.materializeMcp(user, 'agt_1')
    assert.deepEqual(res.scopes, [{ scopeId: 'user', status: 'delivered' }])
    assert.deepEqual(ok.calls, [{ leaseWaitMs: DAEMON_CONFIG_REQUEST_WAIT_MS }])

    const busy = controllerWith(async () => {
        throw new DaemonConfigDeliveryError('busy')
    })
    await assert.rejects(
        busy.controller.materializeMcp(user, 'agt_1'),
        (err: unknown) => {
            assert.ok(err instanceof ConflictException)
            assert.equal(
                (err.getResponse() as { code: string }).code,
                'DAEMON_CONFIG_BUSY'
            )
            return true
        }
    )

    const other = controllerWith(async () => {
        throw new Error('MCP config cannot be pushed to an external runtime')
    })
    await assert.rejects(
        other.controller.materializeMcp(user, 'agt_1'),
        BadRequestException
    )
})
