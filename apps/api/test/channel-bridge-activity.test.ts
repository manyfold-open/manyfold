import assert from 'node:assert/strict'
import test from 'node:test'
import {
    composeActivityPreview,
    pushActivityLine,
    setThinkingLine
} from '../src/modules/channels/channel-bridge.service'

test('pushActivityLine keeps only the most recent 8 lines and clips length', () => {
    const lines: string[] = []
    for (let i = 1; i <= 10; i += 1) pushActivityLine(lines, `⚙ tool-${i}`)
    assert.equal(lines.length, 8)
    assert.equal(lines[0], '⚙ tool-3')
    assert.equal(lines[7], '⚙ tool-10')

    const long: string[] = []
    pushActivityLine(long, `⚙ Bash ${'x'.repeat(300)}`)
    assert.equal(long[0]?.length, 100)
    assert.match(long[0] ?? '', /…$/)
})

test('setThinkingLine coalesces consecutive thinking into one line', () => {
    const lines: string[] = []
    setThinkingLine(lines, 'let me')
    setThinkingLine(lines, 'let me check')
    assert.equal(lines.length, 1)
    assert.equal(lines[0], '💭 let me check')

    pushActivityLine(lines, '⚙ Bash {}')
    setThinkingLine(lines, 'new thought')
    assert.equal(lines.length, 3)
    assert.equal(lines[2], '💭 new thought')
})

test('composeActivityPreview stays under budget and keeps the text tail', () => {
    const lines = ['⚙ Bash {"cmd":"ls"}']
    const short = composeActivityPreview(lines, 'partial answer')
    assert.equal(short, '⚙ Bash {"cmd":"ls"}\n\npartial answer')

    const huge = 'a'.repeat(5000)
    const composed = composeActivityPreview(lines, huge)
    assert.ok(composed.length <= 1500)
    assert.ok(composed.startsWith('⚙ Bash'))
    assert.match(composed, /…a+$/)
    assert.ok(composed.endsWith('a'))

    assert.equal(composeActivityPreview([], 'just text'), 'just text')
    assert.equal(composeActivityPreview(lines, ''), '⚙ Bash {"cmd":"ls"}')
})
