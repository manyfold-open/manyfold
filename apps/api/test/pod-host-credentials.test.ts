import assert from 'node:assert/strict'
import test from 'node:test'
import 'reflect-metadata'
import { agentCredentials } from '@manyfold/db'
import { AgentCredentialsService } from '../src/modules/agents/credentials/agent-credentials.service'
import {
    contextOf,
    k8sHostRow,
    runtimeRow,
    spritesHostRow
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

// Codex reads its endpoint and MCP servers from config.toml, so a credential
// update rewrites it — through the machine's daemon, whatever provider made
// the machine, with the file carried in the exec's env. The key itself is not
// logged in: every turn carries it.
test('a codex credential update rewrites config.toml through the daemon on a sandbox as on a cloud computer', async () => {
    for (const host of [
        spritesHostRow({ id: 'sbx_1', userId: 'usr_1' }),
        k8sHostRow({ id: 'pdh_1', userId: 'usr_1' })
    ]) {
        const { db } = fakeDb()
        const agent = {
            id: 'agt_1',
            userId: 'usr_1',
            framework: 'codex',
            runtimeId: 'art_1',
            model: null,
            modelProviderId: null,
            extras: {}
        }
        const sessions: string[] = []
        const execs: Array<{ stdin?: string; env?: Record<string, string> }> = []
        const slots: string[] = []
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
                            hostId: host.id,
                            framework: 'codex'
                        }),
                        host
                    })
            } as never,
            {
                resolve: async () => ({
                    framework: 'codex',
                    providerId: 'ump_1',
                    value: {
                        openaiApiKey: 'sk-fixture-provider-key',
                        openaiBaseUrl: 'https://gateway.example/v1'
                    }
                })
            } as never,
            { findByApiKey: async () => null } as never,
            {
                withHost: async (
                    args: { host: { id: string }; reason: string },
                    work: (session: unknown) => Promise<unknown>
                ) => {
                    sessions.push(`${args.host.id}:${args.reason}`)
                    return work({
                        exec: async (req: { stdin?: string; env?: Record<string, string> }) => {
                            execs.push(req)
                            return { exitCode: 0, stdout: '', stderr: '' }
                        }
                    })
                }
            } as never,
            {
                reserveActiveSlot: async (input: { hostId: string }) => {
                    slots.push(input.hostId)
                    return {}
                }
            } as never
        )
        await service.update(
            'usr_1',
            'agt_1',
            { codexCredentials: { providerId: 'ump_1' } } as never,
            false
        )
        assert.deepEqual(sessions, [`${host.id}:codex-credentials`])
        assert.equal(execs.length, 1)
        const [rewrite] = execs
        assert.doesNotMatch(rewrite.stdin ?? '', /codex login|sk-fixture-provider-key/)
        const toml = Buffer.from(
            rewrite.env?.MF_CODEX_CONFIG_B64 ?? '',
            'base64'
        ).toString('utf8')
        assert.match(toml, /base_url = "https:\/\/gateway\.example\/v1"/)
        assert.doesNotMatch(toml, /sk-fixture-provider-key/)
        // A sandbox woken for the rewrite takes an active slot first.
        assert.deepEqual(slots, host.id === 'sbx_1' ? ['sbx_1'] : [])
    }
})
