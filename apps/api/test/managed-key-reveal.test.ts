import assert from 'node:assert/strict'
import test from 'node:test'
import 'reflect-metadata'
import { ForbiddenException } from '@nestjs/common'
import type { UserModelProviderRow } from '@manyfold/db'
import { AgentCredentialsService } from '../src/modules/agents/credentials/agent-credentials.service'
import { ModelProvidersService } from '../src/modules/model-providers/model-providers.service'
import {
    contextOf,
    runtimeRow,
    spritesHostRow
} from './helpers/runtime-context-fixture'

// A managed key draws on platform-funded credit; neither reveal route may
// hand it out, while a key the user brought stays revealable.

const refusedAsManaged = (err: unknown): boolean => {
    assert.ok(err instanceof ForbiddenException)
    assert.equal(
        (err.getResponse() as { code?: string }).code,
        'managed_key_not_revealable'
    )
    return true
}

const providerRow = (
    overrides: Partial<UserModelProviderRow>
): UserModelProviderRow =>
    ({
        id: 'ump_1',
        userId: 'usr_1',
        inferenceProtocol: 'anthropic_messages',
        builtInId: null,
        externalAccountId: null,
        providerName: 'Provider',
        apiKeyCiphertext: 'enc:own-key-fixture',
        baseUrl: null,
        modelsListUrl: null,
        keyVersion: 1,
        source: 'byo',
        managedService: null,
        managedBrand: null,
        managedKeyId: null,
        ...overrides
    }) as UserModelProviderRow

const providersService = (row: UserModelProviderRow) => {
    const audits: unknown[] = []
    let decrypts = 0
    const db = {
        select: () => ({
            from: () => ({ where: () => ({ limit: async () => [row] }) })
        }),
        insert: () => ({
            values: async (values: unknown) => {
                audits.push(values)
            }
        })
    }
    const crypto = {
        decrypt: ({ ciphertext }: { ciphertext: string }) => {
            decrypts += 1
            return ciphertext.replace(/^enc:/, '')
        }
    }
    const service = new ModelProvidersService(
        db as never,
        crypto as never,
        {} as never
    )
    return { service, audits, decrypts: () => decrypts }
}

test('provider reveal refuses a managed key before decrypting it', async () => {
    const { service, audits, decrypts } = providersService(
        providerRow({
            providerName: 'Managed Anthropic',
            apiKeyCiphertext: 'enc:managed-key-fixture',
            source: 'managed',
            managedService: 'managed-upstream',
            managedBrand: 'anthropic',
            managedKeyId: 'key_1'
        })
    )
    await assert.rejects(
        () => service.reveal('usr_1', 'ump_1'),
        refusedAsManaged
    )
    assert.equal(decrypts(), 0)
    assert.equal(audits.length, 0)
})

test('provider reveal still returns a key the user brought', async () => {
    const { service, audits } = providersService(providerRow({}))
    assert.deepEqual(await service.reveal('usr_1', 'ump_1'), {
        apiKey: 'own-key-fixture'
    })
    assert.equal(audits.length, 1)
})

const credentialsService = (
    apiKey: string,
    saved: { source: 'byo' | 'managed' } | null
) => {
    const audits: unknown[] = []
    const lookups: Array<{ userId: string; apiKey: string }> = []
    const agent = {
        id: 'agt_1',
        userId: 'usr_1',
        framework: 'claude-code',
        runtimeId: 'art_1',
        hostId: 'hst_1',
        model: null,
        modelProviderId: 'ump_1',
        extras: {}
    }
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [
                        { payloadCiphertext: 'payload', keyVersion: 1 }
                    ]
                })
            })
        }),
        insert: () => ({
            values: async (values: unknown) => {
                audits.push(values)
            }
        })
    }
    const service = new AgentCredentialsService(
        db as never,
        {
            decrypt: () =>
                JSON.stringify({
                    anthropicAuthToken: apiKey,
                    anthropicBaseUrl: null
                })
        } as never,
        {
            contextForCaller: async () =>
                contextOf({
                    agent: agent as never,
                    runtime: runtimeRow({
                        id: 'art_1',
                        userId: 'usr_1',
                        hostId: 'hst_1',
                        framework: 'claude-code'
                    }),
                    host: spritesHostRow({ id: 'hst_1', userId: 'usr_1' })
                })
        } as never,
        {} as never,
        {
            findByApiKey: async (input: { userId: string; apiKey: string }) => {
                lookups.push(input)
                return saved
            }
        } as never,
        {} as never,
        {} as never
    )
    return { service, audits, lookups }
}

test('agent credential reveal refuses a key that belongs to a managed provider', async () => {
    const { service, audits, lookups } = credentialsService(
        'managed-key-fixture',
        { source: 'managed' }
    )
    await assert.rejects(
        () => service.reveal('usr_1', 'agt_1', false),
        refusedAsManaged
    )
    assert.deepEqual(lookups, [
        { userId: 'usr_1', apiKey: 'managed-key-fixture' }
    ])
    assert.equal(audits.length, 0)
})

test('agent credential reveal still returns a key the user brought', async () => {
    for (const saved of [{ source: 'byo' as const }, null]) {
        const { service, audits } = credentialsService('own-key-fixture', saved)
        assert.deepEqual(await service.reveal('usr_1', 'agt_1', false), {
            apiKey: 'own-key-fixture'
        })
        assert.equal(audits.length, 1)
    }
})
