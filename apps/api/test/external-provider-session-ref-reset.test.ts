import { auditAction } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
    auditLogs,
    chatSessions,
    userExternalAgentProviders,
    type UserExternalAgentProviderRow
} from '@manyfold/db'
import { UserExternalAgentProvidersService } from '../src/modules/user-external-agent-providers/user-external-agent-providers.service'

const now = new Date('2026-06-16T09:20:00.000Z')

const providerRow = (
    overrides: Partial<UserExternalAgentProviderRow> = {}
): UserExternalAgentProviderRow => ({
    id: 'ueap_1',
    userId: 'user_1',
    provider: 'dify',
    label: 'Dify',
    endpointUrl: 'https://1.1.1.1/v1',
    apiKeyCiphertext: 'enc:old-key',
    keyVersion: 1,
    metadataJson: {},
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestMessage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
})

class FakeExternalProviderDb {
    readonly updates: Array<{
        table: unknown
        values: Record<string, unknown>
        where?: unknown
    }> = []
    readonly auditRows: Record<string, unknown>[] = []

    constructor(
        readonly row: UserExternalAgentProviderRow = providerRow(),
        readonly clearedRows: Array<{ id: string }> = [
            { id: 'cts_1' },
            { id: 'cts_2' }
        ]
    ) {}

    select() {
        return {
            from: (table: unknown) => ({
                where: () => ({
                    limit: async () =>
                        table === userExternalAgentProviders ? [this.row] : []
                })
            })
        }
    }

    update(table: unknown) {
        return {
            set: (values: Record<string, unknown>) => ({
                where: (where: unknown) => {
                    this.updates.push({ table, values, where })
                    return {
                        returning: async () => {
                            if (table === userExternalAgentProviders)
                                return [{ ...this.row, ...values }]
                            if (table === chatSessions) return this.clearedRows
                            return []
                        }
                    }
                }
            })
        }
    }

    insert(table: unknown) {
        return {
            values: async (values: Record<string, unknown>) => {
                if (table === auditLogs) this.auditRows.push(values)
            }
        }
    }
}

const crypto = {
    encrypt: (plain: string) => ({ ciphertext: `enc:${plain}`, keyVersion: 1 }),
    decrypt: ({ ciphertext }: { ciphertext: string }) =>
        ciphertext.replace(/^enc:/, '')
}

test('external provider endpoint changes clear stale upstream session refs', async () => {
    const db = new FakeExternalProviderDb()
    const service = new UserExternalAgentProvidersService(
        db as never,
        crypto as never
    )

    await service.update({
        userId: 'user_1',
        id: 'ueap_1',
        endpointUrl: 'https://8.8.8.8/v1/'
    })

    const clear = db.updates.find((u) => u.table === chatSessions)
    assert.ok(
        clear,
        'changing endpointUrl must invalidate framework_session_ref for bound sessions'
    )
    assert.equal(clear.values.frameworkSessionRef, null)

    const query = new PgDialect().sqlToQuery(clear.where as never)
    assert.match(query.sql, /"chat_sessions"\."framework_session_ref" is not null/)
    assert.match(query.sql, /"agents"\."extras"->'externalBinding'->>'providerId'/)
    assert.ok(query.params.includes('user_1'))
    assert.ok(query.params.includes('external'))
    assert.ok(query.params.includes('dify'))
    assert.ok(query.params.includes('ueap_1'))

    assert.equal(db.auditRows.length, 1)
    assert.equal(
        db.auditRows[0].action,
        auditAction.EXTERNAL_AGENT_PROVIDER_UPDATED
    )
    assert.deepEqual(db.auditRows[0].meta, {
        provider: 'dify',
        label: 'Dify',
        clearedSessionRefs: 2
    })
})

test('external provider label-only changes keep upstream session refs', async () => {
    const db = new FakeExternalProviderDb()
    const service = new UserExternalAgentProvidersService(
        db as never,
        crypto as never
    )

    await service.update({
        userId: 'user_1',
        id: 'ueap_1',
        label: 'Renamed Dify'
    })

    assert.equal(
        db.updates.some((u) => u.table === chatSessions),
        false,
        'renaming a provider must not discard working conversation refs'
    )
    assert.deepEqual(db.auditRows[0].meta, {
        provider: 'dify',
        label: 'Renamed Dify',
        clearedSessionRefs: 0
    })
})
