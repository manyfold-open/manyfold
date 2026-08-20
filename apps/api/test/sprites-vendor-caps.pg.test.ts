import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { appSettings, createDb, type Database } from '@manyfold/db'
import {
    AdminSettingsService,
    SPRITES_VENDOR_CAPS_SETTING_KEY
} from '@/modules/admin-settings/admin-settings.service'

// Real-Postgres proof for the nested jsonb merge behind the vendor-capacity
// mirror. The one thing a fake cannot honestly model is whether recording
// account B preserves account A: jsonbMerge's shallow `||` would replace the
// whole `accounts` object, and the RMW alternative would lose a concurrent
// writer. Env-gated like the other *.pg.test.ts.
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    svc: AdminSettingsService
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    await db
        .delete(appSettings)
        .where(eq(appSettings.key, SPRITES_VENDOR_CAPS_SETTING_KEY))
    const svc = new AdminSettingsService(db)
    return {
        db,
        svc,
        close: async () => {
            await db
                .delete(appSettings)
                .where(eq(appSettings.key, SPRITES_VENDOR_CAPS_SETTING_KEY))
        }
    }
}

const observation = (slug: string, patch: Record<string, unknown> = {}) => ({
    slug,
    runningLimit: 10,
    warmLimit: 10,
    running: 0,
    warm: 1,
    cold: 5,
    ...patch
})

test('recording a second account preserves the first', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const a = `spa_${randomBytes(4).toString('hex')}`
        const b = `spa_${randomBytes(4).toString('hex')}`
        assert.equal(await h.svc.recordSpritesVendorCapacity(a, observation('acct-a')), true)
        assert.equal(
            await h.svc.recordSpritesVendorCapacity(
                b,
                observation('acct-b', { runningLimit: 6, warm: 3 })
            ),
            true
        )
        const caps = await h.svc.getCachedSpritesVendorCaps()
        assert.deepEqual(Object.keys(caps).sort(), [a, b].sort())
        assert.equal(caps[a].slug, 'acct-a')
        assert.equal(caps[b].slug, 'acct-b')
        assert.equal(caps[b].runningLimit, 6)
        // Both accounts fresh, so the org ceiling is their sum.
        const view = await h.svc.getSpritesVendorCapacity()
        assert.equal(view.runningLimitTotal, 16)
        assert.equal(view.warmTotal, 4)
    } finally {
        await h.close()
    }
})

test('re-recording one account updates it in place', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const a = `spa_${randomBytes(4).toString('hex')}`
        await h.svc.recordSpritesVendorCapacity(a, observation('acct-a', { warm: 1 }))
        assert.equal(
            await h.svc.recordSpritesVendorCapacity(a, observation('acct-a', { warm: 7 })),
            true
        )
        const caps = await h.svc.getCachedSpritesVendorCaps()
        assert.equal(Object.keys(caps).length, 1)
        assert.equal(caps[a].warm, 7)
    } finally {
        await h.close()
    }
})

test('an unchanged fresh observation is skipped', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const a = `spa_${randomBytes(4).toString('hex')}`
        assert.equal(await h.svc.recordSpritesVendorCapacity(a, observation('acct-a')), true)
        assert.equal(await h.svc.recordSpritesVendorCapacity(a, observation('acct-a')), false)
    } finally {
        await h.close()
    }
})

// The policy row and the vendor row are separate keys on purpose; a PUT to the
// admin cap must not disturb the observation the sync loop owns.
test('updating the policy cap leaves the vendor observation intact', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const a = `spa_${randomBytes(4).toString('hex')}`
        await h.svc.recordSpritesVendorCapacity(a, observation('acct-a', { runningLimit: 10 }))
        await h.svc.updateSpritesWholesaleCap('user_pgtest', {
            activeCap: 50,
            softThresholdPct: 90
        })
        const view = await h.svc.getSpritesVendorCapacity()
        assert.equal(view.accounts.length, 1)
        assert.equal(view.policyActiveCap, 50)
        assert.equal(view.runningLimitTotal, 10)
        // The whole point: admission enforces the vendor limit, not the policy.
        assert.equal(view.effectiveActiveCap, 10)
        assert.equal(view.clamped, true)
        const effective = await h.svc.getCachedSpritesEffectiveCap()
        assert.equal(effective.activeCap, 10)
    } finally {
        await h.db
            .delete(appSettings)
            .where(eq(appSettings.key, 'sprites_wholesale_cap'))
        await h.close()
    }
})
