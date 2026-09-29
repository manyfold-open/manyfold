import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTaskList } from '../src/tasks'

// WHY: `sprite-env curl` has no status code to read, so a listing that parses
// is the only proof a task call went through; anything else is not a listing.
test('parseTaskList reads a listing and refuses anything else', () => {
    assert.deepEqual(
        parseTaskList(
            JSON.stringify({
                tasks: [
                    { name: 'mf-hold-0123abcd', started_at: 'a', expires_at: 'b' },
                    { name: 'bare' },
                    { started_at: 'nameless' }
                ]
            })
        ),
        [
            { name: 'mf-hold-0123abcd', startedAt: 'a', expiresAt: 'b' },
            { name: 'bare', startedAt: null, expiresAt: null }
        ]
    )
    assert.deepEqual(parseTaskList('{"tasks":[]}'), [])
    assert.equal(parseTaskList(''), null)
    assert.equal(parseTaskList('curl: (7) Failed to connect'), null)
    assert.equal(parseTaskList('{"error":"not found"}'), null)
})
