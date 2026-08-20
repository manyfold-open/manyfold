import assert from 'node:assert/strict'
import test from 'node:test'
import { toResultPreview } from '../src/modules/automations/automations.service'

test('the preview is the first line of the answer', () => {
    assert.equal(
        toResultPreview('7 unread emails, 2 need replies\n\nDetails follow.'),
        '7 unread emails, 2 need replies'
    )
})

test('leading blank lines are skipped to reach real content', () => {
    assert.equal(
        toResultPreview('\n\n   \nStandup is at 10:30'),
        'Standup is at 10:30'
    )
})

test('markdown scaffolding is stripped so the line reads as prose', () => {
    assert.equal(toResultPreview('# Morning briefing'), 'Morning briefing')
    assert.equal(toResultPreview('### Deploys'), 'Deploys')
    assert.equal(toResultPreview('- two PRs merged'), 'two PRs merged')
    assert.equal(toResultPreview('* two PRs merged'), 'two PRs merged')
    assert.equal(toResultPreview('+ two PRs merged'), 'two PRs merged')
    assert.equal(toResultPreview('1. two PRs merged'), 'two PRs merged')
    assert.equal(toResultPreview('2) two PRs merged'), 'two PRs merged')
    assert.equal(toResultPreview('> quoted line'), 'quoted line')
    assert.equal(toResultPreview('  - indented bullet'), 'indented bullet')
})

test('emphasis and code marks are removed but the words survive', () => {
    assert.equal(
        toResultPreview('**All green** on `staging` and _prod_'),
        'All green on staging and prod'
    )
})

test('a heading-only first line still yields the heading, not the body', () => {
    assert.equal(
        toResultPreview('## Site watch\n\nEverything responded.'),
        'Site watch'
    )
})

test('an answer with nothing to preview yields null', () => {
    assert.equal(toResultPreview(''), null)
    assert.equal(toResultPreview('\n\n'), null)
    assert.equal(toResultPreview('   '), null)
    // A line made only of markdown scaffolding has no prose left.
    assert.equal(toResultPreview('###'), null)
})

test('a long line is truncated with an ellipsis instead of being stored whole', () => {
    const preview = toResultPreview('x'.repeat(500))
    assert.ok(preview)
    assert.equal(preview?.length, 200)
    assert.ok(preview?.endsWith('…'))
})

test('a line at the limit is kept verbatim', () => {
    const exact = 'y'.repeat(200)
    assert.equal(toResultPreview(exact), exact)
    assert.equal(toResultPreview(exact)?.endsWith('…'), false)
})
