import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkJournal } from './check-migration-ownership.mjs'

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
