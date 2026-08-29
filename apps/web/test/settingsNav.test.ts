import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BILLING_SURFACE } from '../src/edition-capabilities'

const testRoot = dirname(fileURLToPath(import.meta.url))
const webRoot = join(testRoot, '..', 'src')

const read = (...parts: string[]): string =>
    readFileSync(join(webRoot, ...parts), 'utf8')

const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) return walk(full)
        return /\.tsx?$/.test(name) ? [full] : []
    })

// The rail's core list, as written — the destinations every edition shows.
const coreNavPaths = (): string[] => {
    const source = read('components', 'SettingsLayout.tsx')
    const start = source.indexOf('const SETTINGS_ITEMS')
    const end = source.indexOf(']', start)
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
    // could not be opened.
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

test('the open-source build declares no billing surface', () => {
    assert.equal(BILLING_SURFACE, false)
})

// Every legitimate reason to name a /settings/plan-and-billing path without
// checking BILLING_SURFACE first. Anything else is a control a self-hosted
// user can reach and that redirects them straight back.
// (App.tsx is absent on purpose: it writes the routes as relative segments,
// so it never spells the full path and the scan does not see it.)
const BILLING_PATH_EXEMPT: Record<string, string> = {
    'lib/pageTitle.ts': 'titles those routes, and never links to them',
    'pages/RuntimesDashboard.tsx':
        'links to /plan-and-billing/sandbox-usage, a real page in both editions'
}

test('nothing links into billing without checking the capability', () => {
    const offenders: string[] = []
    for (const file of walk(webRoot)) {
        const source = readFileSync(file, 'utf8')
        if (!source.includes('/settings/plan-and-billing')) continue
        const rel = relative(webRoot, file).split(sep).join('/')
        if (rel in BILLING_PATH_EXEMPT) continue
        if (!source.includes('BILLING_SURFACE')) offenders.push(rel)
    }
    assert.deepEqual(offenders, [])
})

test('the exemptions still describe files that exist and still link', () => {
    // A stale allowlist entry is how this ratchet goes quiet.
    for (const rel of Object.keys(BILLING_PATH_EXEMPT))
        assert.ok(
            read(rel).includes('/settings/plan-and-billing'),
            `${rel} no longer references billing; drop its exemption`
        )
})
