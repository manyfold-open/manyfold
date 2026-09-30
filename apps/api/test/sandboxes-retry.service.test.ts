import assert from 'node:assert/strict'
import test from 'node:test'
import {
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { SandboxesService } from '../src/modules/sandboxes/sandboxes.service'

// A failed sandbox is built again in its own row (POST /sandboxes/:id/retry):
// admitted under its owner's plan, provisioned the way a create provisions
// one, and left failed again with the new reason when that build fails too.

type HostFixture = Record<string, unknown> & { id: string; userId: string }

const failedHost = (over: Record<string, unknown> = {}): HostFixture => ({
    id: 'sbx_1',
    userId: 'u1',
    kind: 'hosted',
    providerId: 'rtp_1',
    providerRef: { kind: 'sprites', spriteName: 'sbx-1', spriteId: null },
    name: 'sandbox-001',
    status: 'failed',
    failureReason: 'runner did not connect',
    ...over
})

class TestSandboxes extends SandboxesService {
    async get(_userId: string, hostId: string): Promise<never> {
        return { id: hostId } as never
    }
}

const build = (
    opts: {
        host?: HostFixture | null
        provision?: () => Promise<void>
        apiUnreachable?: boolean
    } = {}
) => {
    const host = opts.host === undefined ? failedHost() : opts.host
    const reserved: Array<{ userId: string; hostId: string }> = []
    const provisioned: string[] = []
    const statuses: Array<{ id: string; status: string; reason?: string }> = []
    let current: HostFixture | null = host
    const view = host
        ? { host, provider: null, daemon: null, agentsCount: 0 }
        : null
    const svc = new TestSandboxes(
        {
            getSandboxForUser: async () => view,
            getSandboxById: async () => view
        } as never,
        {
            assertSandboxCanReachApi: () => {
                if (opts.apiUnreachable)
                    throw new ServiceUnavailableException({
                        message: 'a sandbox cannot reach this API',
                        code: 'SANDBOX_API_UNREACHABLE'
                    })
            },
            provisionSandbox: async (args: { host: HostFixture }) => {
                provisioned.push(args.host.id)
                await opts.provision?.()
            }
        } as never,
        {} as never,
        {} as never,
        {
            findById: async () => current,
            setStatus: async (id: string, status: string, reason?: string) => {
                statuses.push({ id, status, reason })
                if (current) current = { ...current, status }
            }
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {
            reserveSandboxRetry: async (input: {
                userId: string
                hostId: string
            }) => {
                reserved.push(input)
                if (current)
                    current = {
                        ...current,
                        status: 'provisioning',
                        failureReason: null
                    }
                return current
            }
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )
    return { svc, reserved, provisioned, statuses }
}

test('a retry admits the failed sandbox under its owner and builds it again', async () => {
    const { svc, reserved, provisioned, statuses } = build()

    const summary = await svc.retry('u1', 'sbx_1')

    assert.deepEqual(reserved, [{ userId: 'u1', hostId: 'sbx_1' }])
    assert.deepEqual(provisioned, ['sbx_1'])
    assert.deepEqual(statuses, [])
    assert.equal(summary.id, 'sbx_1')
})

// WHY: the slot a retry takes back is the owner's, whoever presses the button.
test('an admin retry admits the sandbox under its owner, not the admin', async () => {
    const { svc, reserved } = build({ host: failedHost({ userId: 'u2' }) })

    await svc.retry('admin-1', 'sbx_1', true)

    assert.deepEqual(reserved, [{ userId: 'u2', hostId: 'sbx_1' }])
})

test('a build that fails again leaves the sandbox failed with the new reason', async () => {
    const again = new ServiceUnavailableException({
        message: 'sandbox has no reachable daemon (runner_unavailable)',
        code: 'SANDBOX_DAEMON_OFFLINE'
    })
    const { svc, statuses } = build({
        provision: async () => {
            throw again
        }
    })

    await assert.rejects(() => svc.retry('u1', 'sbx_1'), (err) => err === again)
    assert.deepEqual(statuses, [
        {
            id: 'sbx_1',
            status: 'failed',
            reason: 'sandbox has no reachable daemon (runner_unavailable)'
        }
    ])
})

// WHY: a retry makes a new machine, whose runner would fail to call back
// exactly as the first one did; no slot or VM is spent on finding that out.
test('a retry is refused before anything is admitted when no sandbox could reach the API', async () => {
    const { svc, reserved, provisioned } = build({ apiUnreachable: true })

    await assert.rejects(
        () => svc.retry('u1', 'sbx_1'),
        (err) =>
            err instanceof ServiceUnavailableException &&
            (err.getResponse() as { code?: string }).code ===
                'SANDBOX_API_UNREACHABLE'
    )
    assert.deepEqual(reserved, [])
    assert.deepEqual(provisioned, [])
})

test('a sandbox the caller cannot see is neither admitted nor built', async () => {
    const { svc, reserved, provisioned } = build({ host: null })

    await assert.rejects(() => svc.retry('u1', 'sbx_1'), NotFoundException)
    assert.deepEqual(reserved, [])
    assert.deepEqual(provisioned, [])
})
