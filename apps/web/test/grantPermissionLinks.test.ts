import assert from 'node:assert/strict'
import test from 'node:test'
import { splitGrantPermissionContent } from '../src/components/chat/utils/grantPermissionLinks'

const BASE = 'https://app.example.com/grant-permission?token=tok_abc'

test('lifts a bare grant-permission URL out of the prose', () => {
    const result = splitGrantPermissionContent(
        `Please approve this:\n\n${BASE}`
    )
    assert.deepEqual(result.tokens, ['tok_abc'])
    assert.equal(result.text, 'Please approve this:')
})

test('lifts a markdown-link grant URL and drops the whole link', () => {
    const result = splitGrantPermissionContent(
        `Tap [approve here](${BASE}) to continue.`
    )
    assert.deepEqual(result.tokens, ['tok_abc'])
    assert.equal(result.text, 'Tap  to continue.')
})

test('keeps trailing sentence punctuation after a bare URL', () => {
    const result = splitGrantPermissionContent(`Approve at ${BASE}.`)
    assert.deepEqual(result.tokens, ['tok_abc'])
    assert.equal(result.text, 'Approve at .')
})

test('collects multiple distinct tokens and dedupes repeats', () => {
    const other =
        'https://app.example.com/grant-permission?token=tok_def'
    const result = splitGrantPermissionContent(
        `${BASE}\n${other}\n${BASE}`
    )
    assert.deepEqual(result.tokens, ['tok_abc', 'tok_def'])
    assert.equal(result.text, '')
})

test('returns no tokens when there is no grant URL', () => {
    const result = splitGrantPermissionContent(
        'Just a normal message with https://example.com/docs'
    )
    assert.deepEqual(result.tokens, [])
    assert.equal(
        result.text,
        'Just a normal message with https://example.com/docs'
    )
})

test('ignores grant URLs inside a fenced code block', () => {
    const input = `Here is the call:\n\n\`\`\`\ncurl ${BASE}\n\`\`\``
    const result = splitGrantPermissionContent(input)
    assert.deepEqual(result.tokens, [])
    assert.equal(result.text, input.trim())
})

test('ignores grant URLs inside an inline code span', () => {
    const result = splitGrantPermissionContent(`Run \`${BASE}\` yourself`)
    assert.deepEqual(result.tokens, [])
    assert.equal(result.text, `Run \`${BASE}\` yourself`)
})

test('ignores a /grant-permission URL that carries no token', () => {
    const result = splitGrantPermissionContent(
        'https://app.example.com/grant-permission?foo=bar'
    )
    assert.deepEqual(result.tokens, [])
})
