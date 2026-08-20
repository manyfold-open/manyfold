import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { checkJournal, CLOUD_TABLES } from './check-migration-ownership.mjs'
import { CLOUD_TABLE_CONTRACT } from './editions-cloud-tables.mjs'

const journal = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-ownership-'))
    mkdirSync(join(dir, 'meta'), { recursive: true })
    for (const [name, sql] of Object.entries(files))
        writeFileSync(join(dir, name), sql)
    return dir
}

// The boundary this guards: after the journal split, a core migration that
// touches a cloud table would crash every self-hosted deploy (the table does
// not exist there), and cloud DDL on a core table would fork the two
// editions' schemas — both must fail CI, not staging.
test('core journal touching a cloud table is rejected', () => {
    const dir = journal({
        '0001_bad.sql': 'ALTER TABLE "payments" ADD COLUMN "note" text;'
    })
    const problems = checkJournal(dir, 'core')
    assert.equal(problems.length, 1)
    assert.match(problems[0], /core journal touches cloud table "payments"/)
})

test('core journal FK into a cloud table is rejected', () => {
    const dir = journal({
        '0001_bad.sql':
            'ALTER TABLE "users" ADD CONSTRAINT x FOREIGN KEY ("a") REFERENCES "public"."container_skus"("id");'
    })
    const problems = checkJournal(dir, 'core')
    assert.equal(problems.length, 1)
    assert.match(problems[0], /FK into cloud table "container_skus"/)
})

test('cloud journal DDL on a core table is rejected, FK reference is not', () => {
    const dir = journal({
        '0001_ok.sql':
            'CREATE TABLE "plan_billing_x" (id text);',
        '0002_mixed.sql':
            'ALTER TABLE "plan_subscriptions" ADD CONSTRAINT y FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id");\nALTER TABLE "users" ADD COLUMN "oops" text;'
    })
    const problems = checkJournal(dir, 'cloud')
    assert.equal(problems.length, 2)
    assert.match(problems[0], /cloud journal runs DDL on non-cloud table "plan_billing_x"/)
    assert.match(problems[1], /cloud journal runs DDL on non-cloud table "users"/)
})

test('cloud journal may seed app_settings but no other core table', () => {
    const dir = journal({
        '0001_seed.sql':
            "INSERT INTO public.app_settings (key, value_json) VALUES ('x', '{}');\nINSERT INTO public.plans (id) VALUES ('nope');"
    })
    const problems = checkJournal(dir, 'cloud')
    assert.equal(problems.length, 1)
    assert.match(problems[0], /writes data into core table "plans"/)
})

test('clean journals pass', () => {
    const core = journal({
        '0000_baseline.sql':
            'CREATE TABLE "users" (id text);\nCREATE INDEX "users_idx" ON "users" ("id");'
    })
    const cloud = journal({
        '0000_baseline.sql':
            'CREATE TABLE "payments" (id text, user_id text);\nALTER TABLE "payments" ADD CONSTRAINT f FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");'
    })
    assert.deepEqual(checkJournal(core, 'core'), [])
    assert.deepEqual(checkJournal(cloud, 'cloud'), [])
})

// #886: the ownership matrix and the ESLint `@manyfold/db` deny-list describe
// the same contract. Both now derive from CLOUD_TABLE_CONTRACT; these tests
// pin the derivation so a future edit can't reopen the drift.
test('cloud-table contract entries are complete and unique', () => {
    assert.equal(CLOUD_TABLES.size, CLOUD_TABLE_CONTRACT.length)
    const dbExports = new Set()
    for (const entry of CLOUD_TABLE_CONTRACT) {
        assert.ok(entry.table?.length, 'contract entry missing table name')
        assert.ok(
            entry.dbExport?.length,
            `contract entry for "${entry.table}" missing dbExport`
        )
        dbExports.add(entry.dbExport)
    }
    assert.equal(dbExports.size, CLOUD_TABLE_CONTRACT.length)
})

test('eslint boundary denies exactly the contract dbExports to core files', async () => {
    const config = (await import('../eslint.config.js')).default
    const denyLists = []
    for (const block of config) {
        const rule = block.rules?.['no-restricted-imports']
        if (!Array.isArray(rule)) continue
        for (const opt of rule.slice(1)) {
            for (const path of opt?.paths ?? [])
                if (path?.name === '@manyfold/db')
                    denyLists.push(path.importNames ?? [])
        }
    }
    assert.equal(denyLists.length, 1, 'expected one @manyfold/db deny entry')
    assert.deepEqual(
        [...denyLists[0]].sort(),
        CLOUD_TABLE_CONTRACT.map((e) => e.dbExport).sort()
    )
})

test('lint rejects a cloud-table import in core code but allows commercial modules', async () => {
    const { ESLint } = await import('eslint')
    const eslint = new ESLint({ cwd: fileURLToPath(new URL('..', import.meta.url)) })
    const probe =
        "import { acquisitionOauthTouches, planBilling } from '@manyfold/db'\nexport const x = [acquisitionOauthTouches, planBilling]\n"
    const lintAt = async (filePath) => {
        const [res] = await eslint.lintText(probe, { filePath })
        return res.messages.filter(
            (m) => m.ruleId === 'no-restricted-imports'
        )
    }
    const core = await lintAt('apps/api/src/modules/agents/x886-probe.ts')
    assert.equal(core.length, 2)
    assert.match(core[0].message, /editions boundary/)
    const commercial = await lintAt(
        'apps/api-cloud/src/modules/billing/x886-probe.ts'
    )
    assert.deepEqual(commercial, [])
})
