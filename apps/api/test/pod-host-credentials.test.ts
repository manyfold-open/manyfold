import assert from 'node:assert/strict'
import test from 'node:test'
import 'reflect-metadata'
import { agentCredentials } from '@manyfold/db'
import { AgentCredentialsService } from '../src/modules/agents/credentials/agent-credentials.service'

// A framework prepared bare on a cloud computer (ADR-0035) has no credentials
// row until its first agent picks a provider, exactly like one prepared on a
// sandbox: the update creates the row instead of refusing the agent.

const fakeDb = () => {
    const inserts: Array<{ table: unknown; values: unknown }> = []
    const chain = {
        from: () => chain,
        where: () => chain,
        limit: async () => [],
        set: () => chain,
        then: (resolve: (v: unknown) => void) => resolve([])
    }
    return {
        inserts,
        db: {
            select: () => chain,
            update: () => chain,
            insert: (table: unknown) => ({
                values: async (values: unknown) => {
                    inserts.push({ table, values })
                }
            })
        }
    }
}

test('a bare pod runtime gets its first credentials row from the update', async () => {
    const { db, inserts } = fakeDb()
    const agent = {
        id: 'agt_1',
        userId: 'usr_1',
        framework: 'claude-code',
        runtime: 'k8s',
        runtimeId: 'art_1',
        hostId: 'pdh_1',
        model: null,
        modelProviderId: null,
        extras: {}
    }
    const service = new AgentCredentialsService(
        db as never,
        {
            encrypt: (plain: string) => ({ ciphertext: plain, keyVersion: 1 })
        } as never,
        { findForCaller: async () => agent } as never,
        {
            resolve: async () => ({
                framework: 'claude-code',
                providerId: 'ump_1',
                value: {
                    anthropicAuthToken: 'fixture-token',
                    anthropicBaseUrl: null
                }
            })
        } as never,
        { findByApiKey: async () => null } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )
    const view = await service.update(
        'usr_1',
        'agt_1',
        { claudeCodeCredentials: { providerId: 'ump_1' } } as never,
        false
    )
    assert.equal(view.framework, 'claude-code')
    const row = inserts.find((i) => i.table === agentCredentials)
    assert.ok(row, 'the first credentials row is created')
    assert.equal((row.values as { runtimeId: string }).runtimeId, 'art_1')
})
