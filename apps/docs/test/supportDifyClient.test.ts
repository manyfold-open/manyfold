import test from 'node:test'
import assert from 'node:assert/strict'
import { readPageContext } from '../src/lib/support/difyClient'

const globals = globalThis as unknown as Record<string, unknown>

test('page context fits the lengths the Chatflow Start node accepts', (t) => {
    t.after(() => {
        delete globals.window
        delete globals.document
    })
    globals.window = {
        location: {
            origin: 'https://docs.manyfold.ai',
            pathname: `/docs/${'deep/'.repeat(500)}`,
            search: '?token=secret',
            hash: '#section'
        }
    }
    globals.document = { title: 'T'.repeat(400) }

    // Dify refuses the whole message when an input runs past its declared
    // maximum, so an unusually long page must not make the panel unusable.
    const context = readPageContext('zh-Hans-CN-x-private-tag')
    assert.equal(context.page_url.length, 2048)
    assert.ok(
        context.page_url.startsWith('https://docs.manyfold.ai/docs/deep/')
    )
    assert.ok(!context.page_url.includes('token'))
    assert.equal(context.page_title.length, 256)
    assert.equal(context.page_locale, 'zh-Hans-CN-x-pri')
})
