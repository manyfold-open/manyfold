import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { ConflictException } from '@nestjs/common'
import {
    agentRuntimes,
    agents,
    createDb,
    users,
    whatsappRegistrations,
    type Database,
    type WhatsappRegistrationRow
} from '@manyfold/db'
import type { WASocket } from 'baileys'
import type { ConfigService } from '@nestjs/config'
import type { CryptoService } from '../src/modules/secrets/crypto.service'
import type { RuntimeAccessService } from '../src/modules/runtime-access/runtime-access.service'
import type { ChannelsService } from '../src/modules/channels/channels.service'
import type { ChannelsRepository } from '../src/modules/channels/channels.repository'
import { WhatsappRegistrationService } from '../src/modules/channels/whatsapp-registration.service'

// Real-Postgres proof for the per-user pending cap. The unit suite's fake db
// ignores where-clauses, so it cannot tell whether the count filters on status
// — which is exactly the predicate that went missing. Every unexpired row
// counted, so three cancelled attempts locked a user out of WhatsApp for the
// rest of the TTL and blamed it on "too many pending registrations" (#1052).
// Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     npx tsx --test test/whatsapp-registration-cap.pg.test.ts
// against a migrated DB (`just db-migrate`).
const RUN = process.env.RUN_PG_E2E === '1'

const fakeCrypto = {
    encrypt: (plain: string) => ({
        ciphertext: Buffer.from(plain, 'utf8').toString('base64'),
        keyVersion: 1
    }),
    decrypt: (v: { ciphertext: string }) =>
        Buffer.from(v.ciphertext, 'base64').toString('utf8')
} as unknown as CryptoService

const fakeRuntimeAccess = {
    reserveChannelSlot: async () => undefined
} as unknown as RuntimeAccessService

const fakeConfig = { get: () => 'pgtest-holder' } as unknown as ConfigService

const noopChannels = {
    create: async () => ({ id: 'chn_unused' }),
    update: async (_userId: string, id: string) => ({ id })
} as unknown as ChannelsService

const noopRepo = {
    upsertProviderState: async (row: Record<string, unknown>) => row
} as unknown as ChannelsRepository

// The pairing socket never has to do anything here: these tests stop at the
// cap decision, which happens before the row is even inserted.
class TestService extends WhatsappRegistrationService {
    protected createPairingSocket(): Promise<WASocket> {
        return Promise.resolve({
            ev: { on: () => undefined },
            end: () => undefined
        } as unknown as WASocket)
    }
}

interface Harness {
    db: Database
    svc: WhatsappRegistrationService
    userId: string
    agentId: string
    seed: (
        status: WhatsappRegistrationRow['status'],
        expiresAt: Date
    ) => Promise<void>
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const runtimeId = `art_pgtest_${suffix}`
    const agentId = `agt_pgtest_${suffix}`

    await db
        .insert(users)
        .values({ id: userId, email: `${suffix}@pgtest.local` })
    await db.insert(agentRuntimes).values({
        id: runtimeId,
        userId,
        name: `pgtest-runtime-${suffix}`,
        framework: 'claude-code',
        kind: 'sprites'
    })
    await db.insert(agents).values({
        id: agentId,
        userId,
        name: 'pgtest-agent',
        framework: 'claude-code',
        runtime: 'sprites',
        runtimeId,
        internalId: `internal-${agentId}`
    })

    const svc = new TestService(
        db,
        fakeCrypto,
        fakeRuntimeAccess,
        noopChannels,
        noopRepo,
        fakeConfig
    )

    let seq = 0
    return {
        db,
        svc,
        userId,
        agentId,
        seed: async (status, expiresAt) => {
            seq += 1
            await db.insert(whatsappRegistrations).values({
                id: `war_pgtest_${suffix}_${seq}`,
                userId,
                agentId,
                label: `pgtest-${status}`,
                status,
                expiresAt
            })
        },
        close: async (): Promise<void> => {
            await svc.onModuleDestroy()
            await db.delete(users).where(eq(users.id, userId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

const inFiveMinutes = (): Date => new Date(Date.now() + 5 * 60_000)

test(
    'settled registrations release cap capacity even before they expire',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            // Nothing clears expiresAt on a status transition, so all three of
            // these are still unexpired rows belonging to the user. None of
            // them holds a pairing socket, so none may hold a cap slot.
            await h.seed('cancelled', inFiveMinutes())
            await h.seed('failed', inFiveMinutes())
            await h.seed('expired', inFiveMinutes())

            const summary = await h.svc.start(h.userId, {
                agentId: h.agentId,
                label: 'fourth attempt'
            })
            assert.equal(summary.status, 'pending')
        } finally {
            await h.close()
        }
    }
)

test(
    'three live pending registrations still refuse a fourth',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await h.seed('pending', inFiveMinutes())
            await h.seed('pending', inFiveMinutes())
            await h.seed('pending', inFiveMinutes())

            await assert.rejects(
                h.svc.start(h.userId, {
                    agentId: h.agentId,
                    label: 'fourth attempt'
                }),
                (err: unknown) =>
                    err instanceof ConflictException &&
                    (err.getResponse() as { code?: string }).code ===
                        'too_many_pending_registrations'
            )
        } finally {
            await h.close()
        }
    }
)

test(
    'an expired pending registration does not hold a slot',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const past = new Date(Date.now() - 60_000)
            await h.seed('pending', past)
            await h.seed('pending', past)
            await h.seed('pending', past)

            const summary = await h.svc.start(h.userId, {
                agentId: h.agentId,
                label: 'after the old ones lapsed'
            })
            assert.equal(summary.status, 'pending')
        } finally {
            await h.close()
        }
    }
)
