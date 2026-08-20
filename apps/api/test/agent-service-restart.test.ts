import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import { agentCredentials, agentRuntimes, agents } from '@manyfold/db'
import { AgentServiceRestartService } from '../src/modules/agents/agent-service-restart.service'

const now = new Date('2026-08-11T12:00:00.000Z')

// The environment section's "saved but not yet applied" mark clears by comparing
// the save against the agent's own start time, so a restart that does not record
// one leaves that warning standing forever on every other surface — the CLI, the
// admin app, a second browser. This is the guarantee that makes it clear.
test('restarting records when the agent came back up', async () => {
    const h = harness()

    await h.service.restart('agent-1', 'user-1', false)

    assert.deepEqual(h.bootstrap.restarted, ['agent-1'])
    const startedAt = h.agentRow.startedAt as Date
    assert.ok(startedAt instanceof Date)
    assert.ok(startedAt > (now as Date))
    assert.equal(h.agentRow.updatedAt, startedAt)
})

test('a framework with no service does not get a restart or a new start time', async () => {
    const h = harness({ framework: 'claude-code' })

    await assert.rejects(
        () => h.service.restart('agent-1', 'user-1', false),
        BadRequestException
    )
    assert.deepEqual(h.bootstrap.restarted, [])
    assert.equal(h.agentRow.startedAt, now)
})

// A restart that never reached the service must not claim the env is live.
test('a failed service restart leaves the previous start time alone', async () => {
    const h = harness()
    h.bootstrap.error = new Error('sprite unreachable')

    await assert.rejects(
        () => h.service.restart('agent-1', 'user-1', false),
        /sprite unreachable/
    )
    assert.equal(h.agentRow.startedAt, now)
})

interface Harness {
    service: AgentServiceRestartService
    agentRow: Record<string, unknown>
    bootstrap: FakeBootstrap
}

const harness = (patch: Record<string, unknown> = {}): Harness => {
    const agentRow: Record<string, unknown> = {
        id: 'agent-1',
        userId: 'user-1',
        runtimeId: 'runtime-1',
        name: 'Agent',
        framework: 'hermes',
        runtime: 'sprites',
        status: 'running',
        accountId: 'account-1',
        spriteName: 'sprite-1',
        mountPath: '/workspace',
        extras: {},
        startedAt: now,
        updatedAt: now,
        ...patch
    }
    const bootstrap = new FakeBootstrap()
    const db = new FakeDb(agentRow)
    const agentsService = {
        findForCaller: async () => agentRow,
        get: async () => ({ id: 'agent-1' })
    }
    const accounts = {
        getById: async () => ({ id: 'account-1', slug: 'acct' }),
        decryptToken: () => 'token'
    }
    const crypto = { decrypt: () => '{}' }
    const service = new AgentServiceRestartService(
        db as never,
        accounts as never,
        agentsService as never,
        crypto as never,
        bootstrap as never,
        new FakeBootstrap() as never,
        new FakeBootstrap() as never
    )
    return { service, agentRow, bootstrap }
}

class FakeBootstrap {
    restarted: string[] = []
    error: Error | null = null

    async restart(ctx: { agentId: string }): Promise<void> {
        if (this.error) throw this.error
        this.restarted.push(ctx.agentId)
    }
}

class FakeDb {
    constructor(private readonly agentRow: Record<string, unknown>) {}

    select(): { from: (table: unknown) => FakeSelect } {
        return {
            from: (table: unknown) => {
                if (table === agentCredentials)
                    return new FakeSelect([
                        { payloadCiphertext: 'cipher', keyVersion: 1 }
                    ])
                if (table === agentRuntimes)
                    return new FakeSelect([
                        { controlUiEnabled: false, dashboardEnabled: true }
                    ])
                throw new Error('unexpected select')
            }
        }
    }

    update(table: unknown): {
        set: (patch: Record<string, unknown>) => {
            where: () => Promise<void>
        }
    } {
        if (table !== agents) throw new Error('unexpected update')
        return {
            set: (patch: Record<string, unknown>) => ({
                where: async () => {
                    Object.assign(this.agentRow, patch)
                }
            })
        }
    }
}

class FakeSelect {
    constructor(private readonly rows: Array<Record<string, unknown>>) {}

    where(): FakeSelect {
        return this
    }

    limit(count: number): Promise<Array<Record<string, unknown>>> {
        return Promise.resolve(this.rows.slice(0, count))
    }
}
