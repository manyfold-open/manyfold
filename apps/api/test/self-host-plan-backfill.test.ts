import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException } from '@nestjs/common'
import { CapabilitiesRegistry } from '../src/common/capabilities/capabilities.registry'
import { SelfHostPlanBackfillService } from '../src/modules/self-host-plan-backfill/self-host-plan-backfill.service'
import { UsersService } from '../src/modules/users/users.service'

// The gates that decide whether a deployment may reassign plans at all. Both
// sit in front of every database call, so a db that throws on contact is the
// strongest available proof that they short-circuit.
const explodingDb = new Proxy(
    {},
    {
        get() {
            throw new Error('database must not be touched')
        }
    }
) as never

const config = (planId?: string): never =>
    ({ get: () => planId }) as unknown as never

const cloudRegistry = (): CapabilitiesRegistry => {
    const registry = new CapabilitiesRegistry()
    registry.register('billing')
    return registry
}

test('setPlan refuses on a deployment where billing owns plan assignment', async () => {
    const service = new UsersService(explodingDb, cloudRegistry())
    await assert.rejects(
        service.setPlan('user_1', 'admin_1', 'self_hosted'),
        (err: unknown) => {
            assert.ok(err instanceof ForbiddenException)
            return true
        }
    )
})

test('backfill does nothing on the billing edition', async () => {
    const service = new SelfHostPlanBackfillService(
        explodingDb,
        config('self_hosted'),
        cloudRegistry()
    )
    assert.deepEqual(await service.run(), {
        applied: false,
        reason: 'billing-edition'
    })
})

test('backfill does nothing without a self-host default plan', async () => {
    const registry = new CapabilitiesRegistry()
    for (const value of [undefined, '', '   ', 'free']) {
        const service = new SelfHostPlanBackfillService(
            explodingDb,
            config(value),
            registry
        )
        assert.deepEqual(
            await service.run(),
            { applied: false, reason: 'no-self-host-default' },
            `MF_DEFAULT_PLAN_ID=${JSON.stringify(value)} must not start a backfill`
        )
    }
})
