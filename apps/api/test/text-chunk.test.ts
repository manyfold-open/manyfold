import assert from 'node:assert/strict'
import test from 'node:test'
import {
    chunkText,
    wrapMarkdownTables
} from '../src/modules/channels/text-chunk'

test('chunkText returns text unchanged when within limit', () => {
    assert.deepEqual(chunkText('hello', 100), ['hello'])
})

test('chunkText prefers blank-line then newline then space breaks', () => {
    const para = 'a'.repeat(40)
    const text = `${para}\n\n${para}`
    const chunks = chunkText(text, 50)
    assert.equal(chunks.length, 2)
    assert.equal(chunks[0], para)
    assert.equal(chunks[1], para)
    for (const chunk of chunks) assert.ok(chunk.length <= 50)
})

test('chunkText never splits inside a code fence and reopens with the language tag', () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const text = `intro\n\`\`\`ts\n${body}\n\`\`\`\noutro`
    const chunks = chunkText(text, 60)
    assert.ok(chunks.length > 1)
    for (const chunk of chunks) {
        // Every chunk must have balanced fences.
        const fences = chunk.match(/^```/gm) ?? []
        assert.equal(
            fences.length % 2,
            0,
            `unbalanced fence in chunk:\n${chunk}`
        )
        // Any chunk that contains fenced code keeps the language tag on open.
        if (chunk.includes('```')) assert.ok(/```ts/.test(chunk))
    }
    // Reassembling the code lines across chunks preserves every line.
    const rejoined = chunks.join('\n')
    for (let i = 0; i < 20; i += 1) assert.ok(rejoined.includes(`line ${i}`))
})

test('chunkText keeps a small fenced block whole', () => {
    const text = 'before\n```py\nprint(1)\n```\nafter this is padding'.padEnd(
        90,
        'x'
    )
    const chunks = chunkText(text, 200)
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0], text)
})

test('chunkText handles exact-boundary input', () => {
    const text = 'x'.repeat(50)
    assert.deepEqual(chunkText(text, 50), [text])
})

test('chunkText hard-splits a single overlong line', () => {
    const text = 'y'.repeat(120)
    const chunks = chunkText(text, 50)
    assert.ok(chunks.length >= 3)
    for (const chunk of chunks) assert.ok(chunk.length <= 50)
    assert.equal(chunks.join(''), text)
})

test('wrapMarkdownTables wraps a pipe table in a text fence', () => {
    const text = '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |'
    const wrapped = wrapMarkdownTables(text)
    assert.ok(wrapped.startsWith('```text\n'))
    assert.ok(wrapped.endsWith('\n```'))
    assert.ok(wrapped.includes('| a | b |'))
})

test('wrapMarkdownTables leaves prose with pipes untouched', () => {
    const text = 'choose foo | bar when configuring'
    assert.equal(wrapMarkdownTables(text), text)
})

test('wrapMarkdownTables does not touch a table already inside a fence', () => {
    const text = '```\n| a | b |\n|---|---|\n| 1 | 2 |\n```'
    assert.equal(wrapMarkdownTables(text), text)
})

test('wrapMarkdownTables preserves surrounding prose', () => {
    const text = 'Results:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nDone.'
    const wrapped = wrapMarkdownTables(text)
    assert.ok(wrapped.startsWith('Results:\n\n```text\n'))
    assert.ok(wrapped.endsWith('```\n\nDone.'))
})
