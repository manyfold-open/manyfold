import test from 'node:test'
import assert from 'node:assert/strict'
import { isCascadePath } from '../src/lib/settingsCascadePaths'

test('cascade pages own their own layout', () => {
    for (const pathname of [
        '/settings/runtimes',
        '/settings/runtimes/dashboard',
        '/settings/runtimes/local-daemons',
        '/settings/runtimes/art_abc',
        '/settings/channels',
        '/settings/channels/dashboard',
        '/settings/channels/chn_abc',
        '/settings/channels/new/lark',
        '/settings/model-providers',
        '/settings/model-providers/dashboard',
        '/settings/api-tokens',
        '/settings/api-tokens/dashboard',
        '/settings/api-tokens/new',
        '/settings/api-tokens/tok_abc'
    ])
        assert.equal(isCascadePath(pathname), true, pathname)
})

test('the managed sub-pages under model-providers stay ordinary settings pages', () => {
    // These are cloud-overlay pages reached from inside the providers area.
    // A startsWith match would hand them the full-bleed cascade shell, which
    // has no visible symptom in the open-source build.
    for (const pathname of [
        '/settings/model-providers/managed/new',
        '/settings/model-providers/managed/credit-history'
    ])
        assert.equal(isCascadePath(pathname), false, pathname)
})

test('unrelated settings pages are not cascade', () => {
    for (const pathname of [
        '/settings/general',
        '/settings/usage',
        '/settings/plan-and-billing',
        '/agents'
    ])
        assert.equal(isCascadePath(pathname), false, pathname)
})
