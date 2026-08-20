import assert from 'node:assert/strict'
import test from 'node:test'
import {
    healMarkdownSpan,
    mathSpanRenderable
} from '../src/components/chat/utils/streamingMarkdown'

// What the caller does with the two primitives: heal, then ask whether the
// display formula the heal just closed is one KaTeX will accept.
const trailingRenderable = (healed: string): boolean => {
    const close = healed.lastIndexOf('$$')
    if (close <= 0) return true
    const open = healed.lastIndexOf('$$', close - 1)
    if (open < 0) return true
    return mathSpanRenderable(healed.slice(open + 2, close).trim())
}

test('closes a half-typed bold marker', () => {
    assert.equal(healMarkdownSpan('a **bold'), 'a **bold**')
})

test('closes a half-typed italic marker', () => {
    assert.equal(healMarkdownSpan('a *ital'), 'a *ital*')
})

test('closes a dangling inline code span', () => {
    assert.equal(healMarkdownSpan('run `npm i'), 'run `npm i`')
})

test('closes a dangling strikethrough', () => {
    assert.equal(healMarkdownSpan('~~strike'), '~~strike~~')
})

test('renders an incomplete link as plain text, not a broken href', () => {
    const healed = healMarkdownSpan('see [docs](http')
    assert.ok(!healed.includes(']('))
    assert.ok(healed.includes('docs'))
})

test('drops an incomplete image until its url completes', () => {
    assert.equal(healMarkdownSpan('![alt](htt'), '')
})

test('leaves a lone $ as prose, not inline math', () => {
    assert.equal(healMarkdownSpan('costs $5 today'), 'costs $5 today')
})

test('returns plain prose unchanged and renderable', () => {
    const healed = healMarkdownSpan('just text')
    assert.equal(healed, 'just text')
    assert.equal(trailingRenderable(healed), true)
})

test('closes a dangling display-math delimiter', () => {
    const healed = healMarkdownSpan('$$E = mc^2')
    assert.ok(healed.includes('$$E = mc^2$$'))
    assert.equal(trailingRenderable(healed), true)
})

test('a complete display formula is renderable', () => {
    assert.equal(trailingRenderable(healMarkdownSpan('$$E = mc^2$$')), true)
})

test('a mid-command formula is flagged not-renderable so the caller can hold', () => {
    const healed = healMarkdownSpan('intro $$\\frac{1}{')
    assert.equal(trailingRenderable(healed), false)
    assert.ok(healed.endsWith('$$'))
})

test('an empty formula is treated as renderable', () => {
    assert.equal(mathSpanRenderable(''), true)
})
