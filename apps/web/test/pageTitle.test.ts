import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pageTitleFor } from '../src/lib/pageTitle'

// The title table lists paths a second time, so it can fall out of step with
// the router. This is the signal for that: a new top-level route with no entry
// would otherwise report the bare brand to GA and to the browser tab, which
// looks exactly like a page that never had a title.
test('every absolute route in App.tsx resolves to a title', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    const declared = [...app.matchAll(/path='(\/[^']*)'/g)].map((m) => m[1])
    assert.ok(declared.length > 30, 'route scan found suspiciously few paths')

    const untitled = declared.filter(
        (path) => path !== '/' && pageTitleFor(path) === 'Manyfold'
    )
    assert.deepEqual(untitled, [])
})

test('a new page under a known section inherits the section name', () => {
    assert.equal(
        pageTitleFor('/settings/something-new'),
        'Workspace settings · Manyfold'
    )
    assert.equal(
        pageTitleFor('/settings/plan-and-billing/receipts'),
        'Plan & billing · Manyfold'
    )
})

test('the more specific route wins over the section it sits in', () => {
    assert.equal(pageTitleFor('/agents/agt_01jd'), 'Agent · Manyfold')
    assert.equal(pageTitleFor('/agents/agt_01jd/chat'), 'Chat · Manyfold')
    assert.equal(pageTitleFor('/agents/new'), 'New agent · Manyfold')
})

// Signed out these bounce to /login, so a browser only ever shows the sign-in
// title for them — the mapping still has to be right for the signed-in case.
test('the sign-in variants are distinguishable from each other', () => {
    assert.equal(pageTitleFor('/login/callback'), 'Sign in · Manyfold')
    assert.equal(pageTitleFor('/cli-login'), 'Terminal sign-in · Manyfold')
    assert.equal(
        pageTitleFor('/grant-permission'),
        'Grant permission · Manyfold'
    )
})

test('the campaign pages keep their own branding, unsuffixed', () => {
    // Their copy already ends in a brand; appending another would read
    // "… Agent Challenge · Manyfold".
    const title = pageTitleFor('/challenge')
    assert.match(title, /Manyfold Agent Challenge/)
    assert.doesNotMatch(title, /· Manyfold$/)
})

test('an unrecognised path falls back to the bare brand', () => {
    assert.equal(pageTitleFor('/nothing/here'), 'Manyfold')
})
