import assert from 'node:assert/strict'
import test from 'node:test'
import 'reflect-metadata'
import { agentCredentials } from '@manyfold/db'
import { AgentCredentialsService } from '../src/modules/agents/credentials/agent-credentials.service'
import {
    contextOf,
    k8sHostRow,
    runtimeRow
} from './helpers/runtime-context-fixture'

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
        {
            findForCaller: async () => agent,
            contextForCaller: async () =>
                contextOf({
                    agent: agent as never,
                    runtime: runtimeRow({
                        id: 'art_1',
                        userId: 'usr_1',
                        hostId: 'pdh_1',
                        framework: 'claude-code'
                    }),
                    host: k8sHostRow({ id: 'pdh_1', userId: 'usr_1' })
                })
        } as never,
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

test('a bare hosted agent exposes an empty provider view before its first binding', async () => {
    const { db } = fakeDb()
    const agent = {
        id: 'agt_1',
        userId: 'usr_1',
        framework: 'antigravity-cli',
        runtime: 'k8s',
        runtimeId: 'art_1',
        hostId: 'pdh_1',
        model: 'gemini-3.8-flash-medium',
        modelProviderId: null,
        extras: {},
        updatedAt: new Date()
    }
    const service = new AgentCredentialsService(
        db as never,
        {} as never,
        {
            findForCaller: async () => agent,
            contextForCaller: async () =>
                contextOf({
                    agent: agent as never,
                    runtime: runtimeRow({
                        id: 'art_1',
                        userId: 'usr_1',
                        hostId: 'pdh_1',
                        framework: 'antigravity-cli'
                    }),
                    host: k8sHostRow({ id: 'pdh_1', userId: 'usr_1' })
                })
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )
    const view = await service.getView('usr_1', 'agt_1', false)
    assert.equal(view.framework, 'antigravity-cli')
    assert.equal(view.provider, null)
    assert.equal(view.savedProvider, null)
    assert.equal(view.apiKeyMasked, null)
    assert.equal(view.unsupported, undefined)
})
