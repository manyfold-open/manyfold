import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { planJournalRepairs } from '../src/db/journal-repair'

const journalPath = path.join(process.cwd(), 'drizzle/meta/_journal.json')

const journalEntries = (): { idx: number; tag: string; when: number }[] =>
    JSON.parse(fs.readFileSync(journalPath, 'utf8')).entries

const meta = (hash: string, folderMillis: number) => ({
    sql: [],
    bps: true,
    hash,
    folderMillis
})

// A journal `when` that is ahead of the next entry parks drizzle's high-water
// mark past it, and drizzle skips it forever without failing the deploy (#445).
test('migration journal timestamps increase strictly', () => {
    const entries = journalEntries()
    assert.ok(entries.length > 0)
    for (let i = 1; i < entries.length; i += 1) {
        assert.ok(
            entries[i].when > entries[i - 1].when,
            `${entries[i].tag} (${entries[i].when}) must be after ${entries[i - 1].tag} (${entries[i - 1].when})`
        )
    }
})

test('migration journal carries no future timestamp', () => {
    const now = Date.now()
    for (const entry of journalEntries()) {
        assert.ok(
            entry.when <= now,
            `${entry.tag} is dated in the future (when=${entry.when})`
        )
    }
})

test('journal repair realigns a recorded timestamp that drifted', () => {
    const repairs = planJournalRepairs(
        [meta('aaa', 1785171576000), meta('bbb', 1785180904000)],
        [
            { hash: 'aaa', createdAt: '1785248000000' },
            { hash: 'bbb', createdAt: '1785500000000' }
        ]
    )
    assert.deepEqual(repairs, [
        { hash: 'aaa', from: '1785248000000', to: 1785171576000 },
        { hash: 'bbb', from: '1785500000000', to: 1785180904000 }
    ])
})

test('journal repair is a no-op once the recorded timestamps match', () => {
    const migrations = [meta('aaa', 1785171576000), meta('bbb', 1785180904000)]
    const recorded = [
        { hash: 'aaa', createdAt: '1785171576000' },
        { hash: 'bbb', createdAt: 1785180904000 }
    ]
    assert.deepEqual(planJournalRepairs(migrations, recorded), [])
})

test('journal repair ignores migrations that were never applied', () => {
    const repairs = planJournalRepairs(
        [meta('aaa', 1785171576000), meta('unapplied', 1785337481551)],
        [{ hash: 'aaa', createdAt: '1785248000000' }]
    )
    assert.deepEqual(repairs, [
        { hash: 'aaa', from: '1785248000000', to: 1785171576000 }
    ])
})

test('journal repair leaves a fresh database untouched', () => {
    assert.deepEqual(planJournalRepairs([meta('aaa', 1785171576000)], []), [])
})
