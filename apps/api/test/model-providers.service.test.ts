import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import { userModelProviders, type UserModelProviderRow } from '@manyfold/db'
import {
    ModelProvidersService,
    netmindTokenExpiry
} from '../src/modules/model-providers/model-providers.service'

// A managed-models port with nothing for the brand: managed rows fall back to
// the upstream probe, which is what a cold or unconfigured environment looks
// like. (Catalog freshness is the cloud adapter's concern behind the port.)
const emptyCatalog = () => ({
    enabledModelsForTest: async () => [],
    isManagedBrand: () => true,
    disabledManagedChannels: async () => new Set()
})

const catalogWith = (
    models: Array<{ id: string; ownedBy?: string | null }>
) => {
    const state = { lookups: 0 }
    return {
        isManagedBrand: () => true,
        disabledManagedChannels: async () => new Set(),
        state,
        enabledModelsForTest: async () => {
            state.lookups += 1
            return models
        }
    }
}

// Managed rows serve their list from the platform catalog: the list is
// group-scoped (identical for every user of the brand) and only the catalog
// knows what an admin enabled, so probing upstream per user is both wasteful and
// unable to honour a per-model disable.
test('ModelProvidersService serves managed models from the catalog without probing upstream', async () => {
    const row = modelProviderRow()
    const db = new FakeModelProvidersDb(row)
    const catalog = catalogWith([
        { id: 'gemini-3.6-pro', ownedBy: 'google' },
        { id: 'gemini-3.6-flash', ownedBy: 'google' }
    ])
    const service = new ModelProvidersService(
        db as never,
        { decrypt: () => 'sk-managed-gemini' } as never,
        {
            runTest: async () => {
                throw new Error('managed rows must not probe upstream')
            }
        } as never,
        catalog as never
    )

    const result = await service.testSaved('user_1', row.id)

    assert.equal(result.ok, true)
    assert.deepEqual(
        result.models.map((m) => m.id),
        ['gemini-3.6-pro', 'gemini-3.6-flash']
    )
    assert.equal(catalog.state.lookups, 1)
    assert.equal(db.row.lastTestStatus, 'ok')
    assert.deepEqual(db.row.lastTestModels, {
        google_generate_content: ['gemini-3.6-pro', 'gemini-3.6-flash']
    })
})

// The catalog is seeded lazily, so a brand-new environment has nothing to serve.
// Falling back keeps that environment working instead of showing empty pickers.
test('ModelProvidersService falls back to the upstream probe when the catalog is empty', async () => {
    const row = modelProviderRow()
    const db = new FakeModelProvidersDb(row)
    let runTestCalled = false
    const service = new ModelProvidersService(
        db as never,
        { decrypt: () => 'sk-managed-gemini' } as never,
        {
            runTest: async () => {
                runTestCalled = true
                return {
                    ok: true,
                    status: 'ok',
                    latencyMs: 1,
                    models: [{ id: 'gemini-2.5-pro' }]
                }
            }
        } as never,
        emptyCatalog() as never
    )

    const result = await service.testSaved('user_1', row.id)

    assert.equal(runTestCalled, true)
    assert.equal(result.ok, true)
    assert.deepEqual(db.row.lastTestModels, {
        google_generate_content: ['gemini-2.5-pro']
    })
})

test('ModelProvidersService discovers Managed Gemini models through runTest fallback', async () => {
    const row = modelProviderRow()
    const db = new FakeModelProvidersDb(row)
    let runTestCalled = false
    const service = new ModelProvidersService(
        db as never,
        { decrypt: () => 'sk-managed-gemini' } as never,
        {
            runTest: async () => {
                runTestCalled = true
                return {
                    ok: true,
                    status: 'ok',
                    latencyMs: 1,
                    models: [{ id: 'gemini-2.5-pro' }]
                }
            }
        } as never,
        emptyCatalog() as never
    )

    const result = await service.testSaved('user_1', row.id)

    assert.equal(runTestCalled, true)
    assert.equal(result.ok, true)
    assert.equal(db.row.lastTestStatus, 'ok')
    assert.deepEqual(db.row.lastTestModels, {
        google_generate_content: ['gemini-2.5-pro']
    })
    assert.equal(db.auditRows.length, 1)
})

class FakeModelProvidersDb {
    readonly auditRows: unknown[] = []

    constructor(readonly row: UserModelProviderRow) {}

    select() {
        return {
            from: () => ({
                where: () => ({
                    limit: async () => [this.row]
                })
            })
        }
    }

    update(table: unknown) {
        assert.equal(table, userModelProviders)
        return {
            set: (patch: Partial<UserModelProviderRow>) => ({
                where: () => {
                    Object.assign(this.row, patch)
                    return Object.assign(Promise.resolve(), {
                        returning: async () => [this.row]
                    })
                }
            })
        }
    }

    insert() {
        return {
            values: async (row: unknown) => {
                this.auditRows.push(row)
            }
        }
    }
}

const modelProviderRow = (): UserModelProviderRow =>
    ({
        id: 'ump_google',
        userId: 'user_1',
        inferenceProtocol: 'google_generate_content',
        builtInId: null,
        externalAccountId: null,
        providerName: 'Managed Gemini',
        apiKeyCiphertext: 'enc:sk-managed-gemini',
        baseUrl: 'https://gateway.test',
        modelsListUrl: null,
        keyVersion: 1,
        source: 'managed',
        managedService: 'managed-upstream',
        managedBrand: 'google',
        managedKeyId: 'key_google',
        lastTestedAt: null,
        lastTestStatus: null,
        lastTestMessage: null,
        lastTestModels: null,
        enabledModels: null,
        createdAt: new Date('2026-05-07T14:00:00.000Z'),
        updatedAt: new Date('2026-05-07T14:00:00.000Z')
    }) as UserModelProviderRow

// In-memory multi-row db for createBuiltIn: select().from().where() resolves
// to all rows (single user/builtInId per test), insert appends with defaults.
class MultiRowDb {
    readonly rows: UserModelProviderRow[] = []

    select() {
        return {
            from: () => ({
                where: async () =>
                    this.rows.map((r) => ({ providerName: r.providerName }))
            })
        }
    }

    insert() {
        return {
            values: (values: Partial<UserModelProviderRow>) => ({
                returning: async () => {
                    const row = {
                        ...modelProviderRow(),
                        source: 'byo',
                        managedService: null,
                        managedBrand: null,
                        managedKeyId: null,
                        ...values
                    } as UserModelProviderRow
                    this.rows.push(row)
                    return [row]
                }
            })
        }
    }
}

const cryptoFake = {
    encrypt: (v: string) => ({ ciphertext: `enc:${v}`, keyVersion: 1 }),
    decrypt: ({ ciphertext }: { ciphertext: string }) =>
        ciphertext.replace(/^enc:/, '')
}

test('createBuiltIn allows multiple instances of the same built-in with numbered default names', async () => {
    const db = new MultiRowDb()
    const service = new ModelProvidersService(
        db as never,
        cryptoFake as never,
        {} as never,
        emptyCatalog() as never
    )
    const first = await service.createBuiltIn({
        userId: 'user_1',
        builtInId: 'netmind',
        apiKey: 'sk-key-one-1234'
    })
    const second = await service.createBuiltIn({
        userId: 'user_1',
        builtInId: 'netmind',
        apiKey: 'sk-key-two-1234'
    })
    const named = await service.createBuiltIn({
        userId: 'user_1',
        builtInId: 'netmind',
        apiKey: 'sk-key-three-12',
        providerName: 'NetMind personal',
        externalAccountId: 'usc_9'
    })
    assert.equal(first.providerName, 'NetMind API')
    assert.equal(second.providerName, 'NetMind API 2')
    assert.equal(named.providerName, 'NetMind personal')
    assert.equal(db.rows.length, 3)
    assert.equal(db.rows[2].externalAccountId, 'usc_9')
    assert.equal(db.rows[0].externalAccountId, null)
})

test('update can rename a built-in row but still blocks platform-managed fields', async () => {
    const row = {
        ...modelProviderRow(),
        id: 'ump_netmind',
        builtInId: 'netmind',
        providerName: 'NetMind API',
        source: 'byo',
        managedService: null,
        managedBrand: null,
        managedKeyId: null,
        baseUrl: null
    } as UserModelProviderRow
    const db = new FakeModelProvidersDb(row)
    const service = new ModelProvidersService(
        db as never,
        cryptoFake as never,
        {} as never,
        emptyCatalog() as never
    )

    const renamed = await service.update({
        userId: 'user_1',
        id: row.id,
        providerName: 'NetMind work'
    })
    assert.equal(renamed.providerName, 'NetMind work')
    assert.equal(db.row.providerName, 'NetMind work')

    await assert.rejects(
        () =>
            service.update({
                userId: 'user_1',
                id: row.id,
                baseUrl: 'https://elsewhere.example'
            }),
        BadRequestException
    )
})

const netmindRow = (): UserModelProviderRow =>
    ({
        ...modelProviderRow(),
        id: 'ump_nm',
        builtInId: 'netmind',
        externalAccountId: 'acct_A',
        source: 'byo',
        managedService: null,
        managedBrand: null,
        managedKeyId: null,
        netmindLoginTokenCiphertext: null,
        netmindLoginTokenKeyVersion: null,
        netmindLoginTokenExpiresAt: null
    }) as UserModelProviderRow

const jwtWith = (payload: Record<string, unknown>): string =>
    `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`

test('refreshNetmindLoginToken encrypts + stores the token and its exp', async () => {
    const row = netmindRow()
    const db = new FakeModelProvidersDb(row)
    const service = new ModelProvidersService(
        db as never,
        cryptoFake as never,
        {} as never,
        emptyCatalog() as never
    )
    const token = jwtWith({ exp: 1785661095 })
    await service.refreshNetmindLoginToken('user_1', row.id, token)
    assert.equal(db.row.netmindLoginTokenCiphertext, `enc:${token}`)
    assert.equal(db.row.netmindLoginTokenKeyVersion, 1)
    assert.deepEqual(db.row.netmindLoginTokenExpiresAt, new Date(1785661095000))
})

test('revealNetmindLoginToken decrypts a stored token, null when absent', async () => {
    const row = netmindRow()
    const db = new FakeModelProvidersDb(row)
    const service = new ModelProvidersService(
        db as never,
        cryptoFake as never,
        {} as never,
        emptyCatalog() as never
    )
    assert.equal(await service.revealNetmindLoginToken('user_1', row.id), null)
    db.row.netmindLoginTokenCiphertext = 'enc:mytoken'
    db.row.netmindLoginTokenKeyVersion = 1
    db.row.netmindLoginTokenExpiresAt = new Date(1785661095000)
    assert.deepEqual(await service.revealNetmindLoginToken('user_1', row.id), {
        token: 'mytoken',
        expiresAt: new Date(1785661095000)
    })
})

test('clearNetmindLoginToken nulls the stored token columns', async () => {
    const row = netmindRow()
    row.netmindLoginTokenCiphertext = 'enc:x'
    row.netmindLoginTokenKeyVersion = 1
    row.netmindLoginTokenExpiresAt = new Date('2026-05-07T14:00:00.000Z')
    const db = new FakeModelProvidersDb(row)
    const service = new ModelProvidersService(
        db as never,
        cryptoFake as never,
        {} as never,
        emptyCatalog() as never
    )
    await service.clearNetmindLoginToken('user_1', row.id)
    assert.equal(db.row.netmindLoginTokenCiphertext, null)
    assert.equal(db.row.netmindLoginTokenKeyVersion, null)
    assert.equal(db.row.netmindLoginTokenExpiresAt, null)
})

// A disabled channel must stay in list(): the key is still valid and the agents
// bound to it keep working. Only the pickers hide it, and AgentCredentialsDialog
// needs the row present to keep an already-bound agent's model editable.
test('list flags managed rows on a disabled channel instead of dropping them', async () => {
    const rows: UserModelProviderRow[] = [
        modelProviderRow(),
        {
            ...modelProviderRow(),
            id: 'ump_antigravity',
            providerName: 'Managed Antigravity',
            managedBrand: 'antigravity',
            managedKeyId: 'key_antigravity'
        } as UserModelProviderRow,
        {
            ...modelProviderRow(),
            id: 'ump_byo_gemini',
            providerName: 'My Gemini',
            source: 'byo',
            managedService: null,
            managedBrand: null,
            managedKeyId: null
        } as UserModelProviderRow
    ]
    const service = new ModelProvidersService(
        {
            select: () => ({ from: () => ({ where: async () => rows }) })
        } as never,
        cryptoFake as never,
        {} as never,
        {
            ...emptyCatalog(),
            disabledManagedChannels: async () => new Set(['google'])
        } as never
    )

    const list = await service.list('user_1')

    assert.deepEqual(
        list.map((r) => [r.id, r.channelDisabled ?? false]),
        [
            ['ump_google', true],
            ['ump_antigravity', false],
            ['ump_byo_gemini', false]
        ]
    )
})

test('netmindTokenExpiry decodes exp; null for non-JWT / missing exp', () => {
    assert.deepEqual(
        netmindTokenExpiry(jwtWith({ exp: 1785661095 })),
        new Date(1785661095000)
    )
    assert.equal(netmindTokenExpiry('not-a-jwt'), null)
    assert.equal(netmindTokenExpiry(jwtWith({ foo: 1 })), null)
})
