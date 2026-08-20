import type { AuthSetupBody } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { appSettings, auditLogs } from '@manyfold/db'
import { noManagedModelsPort } from '../src/common/ports/managed-models.ports'
import { AuthSettingsService } from '../src/modules/auth/auth-settings.service'

class FakeDb {
    settings = new Map<string, Record<string, unknown>>()
    audits: Record<string, unknown>[] = []

    select(_shape?: unknown) {
        return new FakeQuery(this, 'select')
    }

    insert(table: unknown) {
        return new FakeQuery(this, 'insert', table)
    }
}

class FakeQuery {
    private table: unknown
    private value: Record<string, unknown> = {}
    private conflictUpdate: Record<string, unknown> | null = null

    constructor(
        private readonly db: FakeDb,
        private readonly op: 'select' | 'insert',
        table?: unknown
    ) {
        this.table = table
    }

    from(table: unknown) {
        this.table = table
        return this
    }

    where(_cond: unknown) {
        return this
    }

    limit(_n: number) {
        if (this.table !== appSettings) return Promise.resolve([])
        const row = this.db.settings.get('auth.login_provider')
        return Promise.resolve(row ? [{ valueJson: row }] : [])
    }

    values(value: Record<string, unknown>) {
        this.value = value
        if (this.table === auditLogs) {
            this.db.audits.push(value)
            return Promise.resolve()
        }
        return this
    }

    onConflictDoNothing() {
        return this
    }

    onConflictDoUpdate(input: { set: Record<string, unknown> }) {
        this.conflictUpdate = input.set
        return this
    }

    returning(): Promise<unknown[]> {
        if (this.op !== 'insert' || this.table !== appSettings)
            return Promise.resolve([])
        const key = this.value.key as string
        if (this.db.settings.has(key) && !this.conflictUpdate)
            return Promise.resolve([])
        const valueJson = (this.conflictUpdate?.valueJson ??
            this.value.valueJson) as Record<string, unknown>
        this.db.settings.set(key, valueJson)
        return Promise.resolve([{ key, valueJson }])
    }

    then<TResult1 = unknown, TResult2 = never>(
        onfulfilled?:
            | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
            | null,
        onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | null
    ): Promise<TResult1 | TResult2> {
        if (
            this.op === 'insert' &&
            this.table === appSettings &&
            this.conflictUpdate
        ) {
            const key = this.value.key as string
            const valueJson = this.conflictUpdate.valueJson as Record<
                string,
                unknown
            >
            this.db.settings.set(key, valueJson)
        }
        return Promise.resolve([]).then(onfulfilled, onrejected)
    }
}

const serviceWith = (db = new FakeDb()): AuthSettingsService =>
    new AuthSettingsService(
        db as never,
        {
            encrypt: (plain: string) => ({
                ciphertext: `enc:${plain}`,
                keyVersion: 1
            }),
            decrypt: (value: { ciphertext: string }) =>
                value.ciphertext.replace(/^enc:/, '')
        } as never,
        {
            get: (key: string) =>
                key === 'AUTH_SETUP_TOKEN' ? 'setup-token' : undefined
        } as never,
        noManagedModelsPort
    )

const setupBody = {
    setupToken: 'setup-token',
    passwordEnabled: true,
    emailVerificationRequired: true,
    googleEnabled: true,
    googleClientId: 'gid',
    googleClientSecret: 'gsecret',
    oidcEnabled: false,
    initialAdminEmails: ['Admin@Example.com'],
    adminEmail: 'admin@example.com',
    adminPassword: 'password123'
} satisfies AuthSetupBody

test('AuthSettingsService protects one-time setup and encrypts provider secrets', async () => {
    const db = new FakeDb()
    const service = serviceWith(db)

    await assert.rejects(
        () => service.setup({ ...setupBody, setupToken: 'wrong' }),
        /invalid setup token/
    )

    const view = await service.setup({ ...setupBody })

    assert.deepEqual(view, {
        configured: true,
        provider: 'native',
        password: { enabled: true },
        google: { enabled: true, clientId: 'gid', hasClientSecret: true },
        oidc: null,
        netmind: null,
        emailVerificationRequired: true,
        initialAdminEmails: ['admin@example.com']
    })
    assert.deepEqual(await service.getPublicConfig(), {
        configured: true,
        provider: 'native',
        methods: { password: true, google: true, oidc: false, netmind: false },
        emailVerificationRequired: true,
        oidcButtonLabel: null,
        netmind: null
    })
    const priv = await service.getPrivateSettings()
    assert.equal(priv.provider, 'native')
    assert.equal(priv.google?.clientSecret, 'gsecret')

    await assert.rejects(
        () => service.setup({ ...setupBody }),
        /already configured/
    )
})

test('AuthSettingsService toggles methods, trims authority, and invalidates cache', async () => {
    const service = serviceWith()
    await service.setup({
        ...setupBody,
        googleEnabled: false,
        googleClientId: undefined,
        googleClientSecret: undefined
    })
    const before = await service.getPublicConfig()
    assert.ok(before.configured)
    assert.deepEqual(before.methods, {
        password: true,
        google: false,
        oidc: false,
        netmind: false
    })

    const view = await service.update('user-1', {
        passwordEnabled: true,
        emailVerificationRequired: false,
        googleEnabled: false,
        oidcEnabled: true,
        oidcAuthority: 'https://idp.example.com/',
        oidcClientId: 'nca',
        oidcClientSecret: 'osecret',
        oidcAudience: 'example-api',
        oidcScope: 'openid email',
        oidcTokenSource: 'id_token',
        oidcUserIdClaim: 'sub',
        oidcEmailClaim: 'email',
        oidcButtonLabel: 'Okta',
        initialAdminEmails: ['owner@example.com']
    })

    assert.equal(view.oidc?.enabled, true)
    assert.equal(view.oidc?.authority, 'https://idp.example.com')
    assert.equal(view.oidc?.hasClientSecret, true)
    const pub = await service.getPublicConfig()
    assert.ok(pub.configured)
    assert.deepEqual(pub.methods, {
        password: true,
        google: false,
        oidc: true,
        netmind: false
    })
    assert.equal(pub.oidcButtonLabel, 'Okta')
    const priv = await service.getPrivateSettings()
    assert.equal(priv.oidc?.clientSecret, 'osecret')
    assert.equal(priv.emailVerificationRequired, false)
    assert.deepEqual(Array.from(await service.getInitialAdminEmails()), [
        'owner@example.com'
    ])
})
