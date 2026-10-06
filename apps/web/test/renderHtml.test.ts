import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderHtml } from '../src/seo/renderHtml'

// Thousands of short Chinese text chunks put a three-byte character across
// react-dom's 2 KB stream view over and over, which is where its Node stream
// leaves zero bytes behind. The markup has to come out exactly as rendered.
test('renderHtml keeps multi-byte text intact across stream views', async () => {
    const words = Array.from({ length: 2000 }, (_, index) =>
        createElement('span', { key: index }, '终端')
    )
    assert.equal(
        await renderHtml(createElement('p', null, words)),
        `<p>${'<span>终端</span>'.repeat(2000)}</p>`
    )
})
