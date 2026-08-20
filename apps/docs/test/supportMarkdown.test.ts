import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from '../src/lib/support/markdown'

// The support agent's answers are LLM output written straight into innerHTML,
// and they quote knowledge-base chunks verbatim. Escaping is the only thing
// standing between a poisoned doc chunk and script execution, so it gets tests
// even though the rest of apps/docs has none.
test('raw HTML in an answer never reaches the DOM as markup', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>')
    assert.ok(!html.includes('<img'))
    assert.ok(html.includes('&lt;img'))
})

test('inline code keeps angle brackets escaped', () => {
    assert.ok(renderMarkdown('run `<b>` here').includes('<code>&lt;b&gt;</code>'))
})

test('javascript: and data: links are rendered inert', () => {
    const js = renderMarkdown('[click](javascript:alert(1))')
    assert.ok(!js.includes('href'))
    assert.ok(js.includes('click'))
    assert.ok(!renderMarkdown('[x](data:text/html,y)').includes('href'))
})

test('relative links stay in-app and external links are hardened', () => {
    const internal = renderMarkdown('[docs](/docs/faq/)')
    assert.ok(internal.includes('href="/docs/faq/"'))
    assert.ok(!internal.includes('target'))

    const external = renderMarkdown('[m](https://a.example/x)')
    assert.ok(external.includes('target="_blank"'))
    assert.ok(external.includes('rel="noopener noreferrer"'))
})

test('a markdown link is not also autolinked', () => {
    const html = renderMarkdown('[t](https://a.example)')
    assert.equal((html.match(/<a /g) ?? []).length, 1)
})

// Regression: the inline-code placeholder used to be a bare digit marker, which
// swallowed ordinary numbers in prose and mis-restored adjacent code spans.
test('plain numbers survive the inline-code placeholder', () => {
    const html = renderMarkdown('you get 3 agents and 5 runtimes')
    assert.ok(html.includes('3'))
    assert.ok(html.includes('5'))
    assert.ok(!html.includes('undefined'))
})

test('adjacent inline code spans both restore', () => {
    const html = renderMarkdown('use `a` and `b` now')
    assert.ok(html.includes('<code>a</code>'))
    assert.ok(html.includes('<code>b</code>'))
})

test('fenced code renders, even while the fence is still open mid-stream', () => {
    const closed = renderMarkdown('```bash\nmf login\n```')
    assert.ok(closed.includes('docs-support-code'))
    assert.ok(closed.includes('mf login'))

    const streaming = renderMarkdown('```\nmf log')
    assert.ok(streaming.includes('<pre>'))
    assert.ok(streaming.includes('mf log'))
})

test('lists, tables, quotes and emphasis render', () => {
    assert.equal((renderMarkdown('- one\n- two').match(/<li>/g) ?? []).length, 2)
    assert.equal(
        (renderMarkdown('1. one\n2. two').match(/<li>/g) ?? []).length,
        2
    )

    const table = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')
    assert.ok(table.includes('<th>a</th>'))
    assert.ok(table.includes('<td>1</td>'))

    assert.ok(renderMarkdown('> note').includes('<blockquote>'))

    const emphasis = renderMarkdown('**b** and *i*')
    assert.ok(emphasis.includes('<strong>b</strong>'))
    assert.ok(emphasis.includes('<em>i</em>'))
})

// Answers sit inside the panel, below its own heading, so a document-level h1
// would outrank it.
test('headings are demoted to fit inside the panel', () => {
    assert.ok(renderMarkdown('# Title').includes('<h3>Title</h3>'))
})