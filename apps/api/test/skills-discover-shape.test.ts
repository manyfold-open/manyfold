import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import { SkillsController } from '../src/modules/skills/skills.controller'

// Released CLI binaries iterate GET /skills/discover as a bare array. The
// controller must keep that shape whenever none of the new pagination or
// filter params are present, and only envelope when they are.
class FakeService {
    discoverCalls: unknown[] = []
    discoverPageCalls: unknown[] = []

    async discover(input: unknown): Promise<unknown[]> {
        this.discoverCalls.push(input)
        return []
    }

    async discoverPage(input: unknown): Promise<unknown> {
        this.discoverPageCalls.push(input)
        return { items: [], nextCursor: null }
    }
}

const user = { userId: 'user-1' } as never

test('discover without new params stays on the legacy bare-array path', async () => {
    const service = new FakeService()
    const controller = new SkillsController(service as never)

    const result = await controller.discover(user, undefined, 'pdf', 'repo-1')

    assert.ok(Array.isArray(result))
    assert.equal(service.discoverCalls.length, 1)
    assert.equal(service.discoverPageCalls.length, 0)
})

test('discover envelopes when any pagination or filter param is present', async () => {
    const service = new FakeService()
    const controller = new SkillsController(service as never)

    const bySort = await controller.discover(
        user,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'featured'
    )
    assert.deepEqual(bySort, { items: [], nextCursor: null })

    await controller.discover(
        user,
        undefined,
        undefined,
        undefined,
        'cat_abc'
    )
    await controller.discover(
        user,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '24'
    )
    assert.equal(service.discoverCalls.length, 0)
    assert.equal(service.discoverPageCalls.length, 3)
})

test('discover rejects malformed sort and limit params', async () => {
    const service = new FakeService()
    const controller = new SkillsController(service as never)

    await assert.rejects(
        Promise.resolve().then(() =>
            controller.discover(
                user,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                'popular'
            )
        ),
        BadRequestException
    )
    await assert.rejects(
        Promise.resolve().then(() =>
            controller.discover(
                user,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                'abc'
            )
        ),
        BadRequestException
    )
})
