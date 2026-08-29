import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extraSettingsNavItems } from '../src/settings-nav-extra'

const testRoot = dirname(fileURLToPath(import.meta.url))
const webRoot = join(testRoot, '..', 'src')

const read = (...parts: string[]): string =>
    readFileSync(join(webRoot, ...parts), 'utf8')

// The rail's core list, as written — the destinations every edition shows.
const coreNavPaths = (): string[] => {
    const source = read('components', 'SettingsLayout.tsx')
    const start = source.indexOf('const SETTINGS_ITEMS')
    const end = source.indexOf('const NAV_ITEMS', start)
    assert.ok(start >= 0 && end > start, 'SETTINGS_ITEMS not found')
    return [...source.slice(start, end).matchAll(/to: '([^']+)'/g)].map(
        (m) => m[1]
    )
}

// path segment under /settings -> the module App.tsx lazy-loads for it.
const settingsRouteModules = (): Map<string, string> => {
    const app = read('App.tsx')
    const lazies = new Map(
        [
            ...app.matchAll(
                /const (\w+) = lazyChunk\(\s*\(\) =>\s*import\('@\/([^']+)'\)/g
            )
        ].map((m) => [m[1], m[2]])
    )
    const out = new Map<string, string>()
    for (const [, path, component] of app.matchAll(
        /<Route\s+path='([a-z0-9-]+)(?:\/\*)?'\s+element=\{<(\w+) \/>\}/g
    )) {
        const module = lazies.get(component)
        if (module) out.set(`/settings/${path}`, module)
    }
    return out
}

// An editions slot: the open-source file exists only so the cloud overlay has
// something to shadow, and on its own it navigates away.
const isRedirectSlot = (module: string): boolean => {
    let source: string
    try {
        source = read(`${module}.tsx`)
    } catch {
        return false
    }
    return source.includes('Editions slot') && source.includes('<Navigate')
}

test('the open-source rail links nothing that only redirects away', () => {
    // Plan & billing was listed here while its open-source page bounced
    // straight back to /settings, so a self-hosted user saw an entry that
    // could not be opened. Billing moved to the editions slot below.
    const modules = settingsRouteModules()
    const dead = coreNavPaths().filter((path) => {
        const module = modules.get(path)
        return module !== undefined && isRedirectSlot(module)
    })
    assert.deepEqual(dead, [])
})

test('the settings routes this test reads are actually resolvable', () => {
    // Guards the parsing above: if App.tsx stops matching these shapes the
    // test would silently pass on an empty map.
    const modules = settingsRouteModules()
    assert.ok(modules.size >= 6, `only matched ${modules.size} settings routes`)
    assert.equal(
        modules.get('/settings/plan-and-billing'),
        'pages/Settings/PlanAndBilling'
    )
    assert.ok(isRedirectSlot('pages/Settings/PlanAndBilling'))
    assert.equal(isRedirectSlot('pages/Settings/General'), false)
})

test('the open-source edition contributes no commercial rail entries', () => {
    assert.deepEqual(extraSettingsNavItems, [])
})
