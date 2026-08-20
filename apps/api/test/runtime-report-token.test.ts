import test from 'node:test'
import assert from 'node:assert/strict'
import type { Database } from '@manyfold/db'
import type { CryptoService } from '../src/modules/secrets/crypto.service'
import { ensureRuntimeReportToken } from '../src/modules/agents/keep-alive/runtime-report-token'

// Keep-alive reporting (#108): the per-runtime report token rides the framework
// credentials ciphertext (agent_credentials.payloadCiphertext) next to
// gatewayToken/apiServerKey. ensureRuntimeReportToken is the lazy-fleet
// convergence path called from writeStartScript on every non-install
// start.sh rewrite, so it must merge — never clobber — the shared payload,
// and it must never create the credentials row: row creation belongs to the
// provisioning orchestrator, and inserting here would race provisioning.

const RUNTIME_ID = 'rt_phase3test'
const SIBLING_GATEWAY_TOKEN = 'gw-sibling-token'
const CURRENT_KEY_VERSION = 2
const HEX64 = /^[a-f0-9]{64}$/

interface CredentialsRow {
    runtimeId: string
    payloadCiphertext: string
    keyVersion: number
    updatedAt: Date | null
}

// Reversible identity "encryption" so the test can read back exactly what
// the helper re-encrypted; encrypt stamps a NEWER key version than the
// stored row to observe that re-encryption lands at the current version.
const makeCrypto = (): CryptoService =>
    ({
        encrypt: (plain: string) => ({
            ciphertext: plain,
            keyVersion: CURRENT_KEY_VERSION
        }),
        decrypt: ({ ciphertext }: { ciphertext: string }) => ciphertext
    }) as unknown as CryptoService

const makeDb = (initial: CredentialsRow | null) => {
    let row = initial
    const updatePatches: Array<Partial<CredentialsRow>> = []
    let insertCalls = 0
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: () => ({
                        // credential-merge runs inside a row lock; the plain
                        // await path (no .for) stays for non-locking readers
                        for: async () => (row ? [row] : []),
                        then: (
                            resolve: (rows: CredentialsRow[]) => unknown
                        ) => resolve(row ? [row] : [])
                    })
                })
            })
        }),
        update: () => ({
            set: (patch: Partial<CredentialsRow>) => ({
                where: async () => {
                    updatePatches.push(patch)
                    row = { ...(row as CredentialsRow), ...patch }
                }
            })
        }),
        insert: () => {
            insertCalls += 1
            return { values: async () => {} }
        },
        transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
            fn(db)
    }
    return {
        db: db as unknown as Database,
        updatePatches,
        insertCount: () => insertCalls,
        storedRow: () => row
    }
}

const baseRow = (): CredentialsRow => ({
    runtimeId: RUNTIME_ID,
    payloadCiphertext: JSON.stringify({
        gatewayToken: SIBLING_GATEWAY_TOKEN
    }),
    keyVersion: 1,
    updatedAt: null
})

test('ensureRuntimeReportToken mints and persists a token on first call', async () => {
    const { db, updatePatches, storedRow } = makeDb(baseRow())
    const token = await ensureRuntimeReportToken(db, makeCrypto(), RUNTIME_ID)
    assert.ok(token, 'an existing credentials row without a token must mint one')
    assert.match(
        token,
        HEX64,
        'token matches the sibling generators sharing the same ciphertext (randomBytes(32).hex) — no brand prefix on an internal-only value'
    )
    assert.equal(
        updatePatches.length,
        1,
        'the minted token must be persisted so the report handler can verify the bearer the reporter presents'
    )
    const stored = storedRow()
    assert.ok(stored)
    assert.equal(
        (JSON.parse(stored.payloadCiphertext) as Record<string, unknown>)
            .runtimeReportToken,
        token,
        'the returned token and the persisted runtimeReportToken key must be the same value'
    )
    assert.equal(
        stored.keyVersion,
        CURRENT_KEY_VERSION,
        'the merged payload is re-encrypted at the CURRENT key version, and keyVersion is updated alongside payloadCiphertext'
    )
})

test('ensureRuntimeReportToken is idempotent: second call returns the same token with no second update', async () => {
    const { db, updatePatches } = makeDb(baseRow())
    const crypto = makeCrypto()
    const first = await ensureRuntimeReportToken(db, crypto, RUNTIME_ID)
    const second = await ensureRuntimeReportToken(db, crypto, RUNTIME_ID)
    assert.ok(first)
    assert.equal(
        second,
        first,
        'every wake-path start.sh rewrite calls this helper; it must return the existing token, not rotate it'
    )
    assert.equal(
        updatePatches.length,
        1,
        'no second update: an extra re-encryption per wake is a needless RMW on the shared framework-credentials ciphertext'
    )
})

test('minting preserves sibling payload keys: gatewayToken survives re-encryption', async () => {
    const { db, storedRow } = makeDb(baseRow())
    await ensureRuntimeReportToken(db, makeCrypto(), RUNTIME_ID)
    const stored = storedRow()
    assert.ok(stored)
    assert.equal(
        (JSON.parse(stored.payloadCiphertext) as Record<string, unknown>)
            .gatewayToken,
        SIBLING_GATEWAY_TOKEN,
        'the token rides the framework-credentials ciphertext and must not clobber it — losing gatewayToken would break the framework gateway auth'
    )
})

test('ensureRuntimeReportToken returns null WITHOUT inserting when the credentials row is missing', async () => {
    const { db, updatePatches, insertCount } = makeDb(null)
    const token = await ensureRuntimeReportToken(db, makeCrypto(), RUNTIME_ID)
    assert.equal(
        token,
        null,
        'a missing row means the reporter is simply not installed this round'
    )
    assert.equal(
        insertCount(),
        0,
        'row creation belongs to the provisioning orchestrator — inserting here would race an in-flight provision'
    )
    assert.equal(
        updatePatches.length,
        0,
        'the missing-row path must be fully inert: zero writes of any kind'
    )
})
