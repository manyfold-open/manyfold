import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import type { PluggableList } from 'unified'
import CachedMarkdown from '../src/components/chat/utils/cachedMarkdown'

const REMARK: PluggableList = [
    remarkGfm,
    [remarkMath, { singleDollarTextMath: false }]
]
const REHYPE: PluggableList = [
    [
        rehypeHighlight,
        {
            detect: true,
            subset: [
                'typescript',
                'tsx',
                'javascript',
                'jsx',
                'python',
                'bash',
                'json',
                'yaml',
                'html',
                'css',
                'sql',
                'rust',
                'go'
            ]
        }
    ],
    rehypeKatex
]

// react-markdown is the reference: CachedMarkdown reuses one frozen processor
// instead of rebuilding it per render, but must render byte-identically.
const viaReactMarkdown = (md: string): string =>
    renderToStaticMarkup(
        createElement(
            Markdown,
            { remarkPlugins: REMARK, rehypePlugins: REHYPE, components: {} },
            md
        )
    )

const viaCached = (md: string): string =>
    renderToStaticMarkup(
        createElement(CachedMarkdown, { markdown: md, components: {} })
    )

const cases: Array<[string, string]> = [
    ['emphasis + inline code', 'A para with **bold**, *italic* and `code`.'],
    ['heading then paragraph', '# Title\n\nBody text here.'],
    ['fenced code (typescript)', '```typescript\nconst x: number = 42\n```'],
    ['fenced code (no language)', '```\nplain text block\n```'],
    ['gfm table', '| a | b |\n| - | - |\n| 1 | 2 |'],
    ['gfm strikethrough + task list', '~~gone~~\n\n- [ ] todo\n- [x] done'],
    ['display math', 'Energy is $$E = mc^2$$ today.'],
    ['prose dollars are not math', 'It costs $5 and then $10 later.'],
    ['ordinary link', 'See [the docs](https://example.com/x).'],
    ['autolink', 'Visit <https://example.com> now.'],
    ['image', '![alt text](https://example.com/p.png)'],
    ['raw html is escaped to text', 'Generic <string> and a <div>block</div>.'],
    ['blockquote + nested list', '> quote\n>\n> - one\n> - two'],
    ['multi-block message', '## Heading\n\nPara one.\n\n```python\nprint(1)\n```\n\n- a\n- b']
]

for (const [label, md] of cases) {
    test(`cached render matches react-markdown: ${label}`, () => {
        assert.equal(viaCached(md), viaReactMarkdown(md))
    })
}

test('a javascript: link is sanitized to an empty href (not executed)', () => {
    const md = 'Click [here](javascript:alert(1)) now.'
    const cached = viaCached(md)
    assert.equal(cached, viaReactMarkdown(md))
    assert.ok(!cached.includes('javascript:'))
})

test('a javascript: image src is sanitized', () => {
    const md = '![x](javascript:alert(1))'
    const cached = viaCached(md)
    assert.equal(cached, viaReactMarkdown(md))
    assert.ok(!cached.includes('javascript:'))
})
