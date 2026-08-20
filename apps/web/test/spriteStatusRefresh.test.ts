import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SpriteStatusRefresh } from '../src/components/SpriteStatusRefresh'

// The status badge IS the refresh control — it must render as an activatable
// button carrying the lifecycle label and its tone. Freshness rides the
// host-update SSE stream now, so the old auto-refresh countdown must be gone:
// its presence would mean the panel went back to polling refresh-status.
test('renders the lifecycle status as a button without a polling countdown', () => {
    const html = renderToStaticMarkup(
        createElement(SpriteStatusRefresh, {
            spriteStatus: 'warm',
            hostId: 'sbx_x',
            onRefresh: async (): Promise<void> => {}
        })
    )
    assert.match(html, /<button/)
    assert.match(html, /Warm/)
    assert.match(html, /tag-warning/)
    assert.doesNotMatch(html, /\d+s/)
    assert.doesNotMatch(html, /Auto-refreshes/)
})

test('a not-yet-reported sprite renders as provisioning', () => {
    const html = renderToStaticMarkup(
        createElement(SpriteStatusRefresh, {
            spriteStatus: null,
            hostId: 'sbx_x',
            onRefresh: async (): Promise<void> => {}
        })
    )
    assert.match(html, /Provisioning/)
})