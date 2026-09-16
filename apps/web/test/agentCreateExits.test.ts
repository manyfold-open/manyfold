import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NEW_RUNTIME_OPTIONS } from '../src/lib/newRuntimeOptions'
import { EXIT_RENT_CLOUD_COMPUTER } from '../src/pages/AgentNew/v4/exits'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

// The router's own table. Relative children are declared inside a parent
// element, and the create flow only ever aims at `/settings`, so that is the
// one parent this reconstructs — which makes the set slightly permissive and
// never strict. It still rejects a first segment the router does not declare
// anywhere, which is the whole failure being guarded against.
const routeMatchers = (): RegExp[] => {
    const app = readFileSync(join(webRoot, 'App.tsx'), 'utf8')
    const literals = [...app.matchAll(/<Route\s+path='([^']+)'/g)].map(
        (m) => m[1]
    )
    assert.ok(literals.length > 20, 'no routes parsed out of App.tsx')
    const paths = [
        ...literals.filter((p) => p.startsWith('/')),
        ...literals
            .filter((p) => !p.startsWith('/') && p !== '*')
            .map((p) => '/settings/' + p)
    ]
    return paths.map(
        (p) =>
            new RegExp(
                '^' +
                    p
                        .replace(/\/\*$/, '(/.*)?')
                        .replace(/:[A-Za-z]+/g, '[^/]+') +
                    '$'
            )
    )
}

const matchers = routeMatchers()
const resolves = (path: string): boolean =>
    matchers.some((re) => re.test(path))

// Renting a cloud computer is the only row left that leaves: it ends in a
// purchase, on a surface the cloud edition owns. Signing in, connecting your
// own computer and connecting a service all finish inside their own step now.
const EXITS = [EXIT_RENT_CLOUD_COMPUTER]

// Seen on staging [2026-09-15]: every one of these was a hand-written URL that
// matched no route, so picking "Connect my computer", "Cloud computer" or
// "Sign in to Claude" fell through to the catch-all and dropped the user into
// a chat, halfway through creating an agent, with no message.
test('every exit out of the create flow is a route the app declares', () => {
    for (const path of EXITS)
        assert.ok(resolves(path), `${path} matches no route in App.tsx`)
})

// The other half of the same bug: the paths also carried `?addAccount=1`,
// `?connect=daemon` and `?buy=cloud-computer`, which nothing read. A query
// parameter that no page consumes is a promise the destination cannot keep.
test('no exit leans on a query parameter', () => {
    for (const path of EXITS)
        assert.equal(path.includes('?'), false, `${path} carries a query`)
})

// `NEW_RUNTIME_OPTIONS` documents itself as the single source for where a new
// runtime of each kind gets created, so that destinations "cannot drift apart".
// They drifted because this flow wrote its own instead of reading it.
test('the cloud-computer exit is the one the rest of the app uses', () => {
    assert.equal(
        EXIT_RENT_CLOUD_COMPUTER,
        NEW_RUNTIME_OPTIONS.find((o) => o.kind === 'k8s')?.to
    )
})

const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) return walk(full)
        return /\.tsx?$/.test(name) ? [full] : []
    })

// Catches the next hand-written path before it ships, including the ones
// built by concatenation — `'/runtimes/' + id` only ever exposes its first
// segment to a reader, and the first segment is exactly what was wrong.
test('the create flow writes no path the router has never heard of', () => {
    const topLevel = new Set(
        [
            ...readFileSync(join(webRoot, 'App.tsx'), 'utf8').matchAll(
                /<Route\s+path='\/([a-z0-9-]+)/g
            )
        ].map((m) => m[1])
    )
    assert.ok(topLevel.has('settings') && topLevel.has('agents'))
    for (const file of walk(join(webRoot, 'pages', 'AgentNew', 'v4'))) {
        const source = readFileSync(file, 'utf8')
        for (const [, literal] of source.matchAll(/'(\/[a-z0-9-]+[^']*)'/g)) {
            const segment = literal.split('/')[1]
            assert.ok(
                topLevel.has(segment),
                `${file}: '${literal}' starts at /${segment}, which App.tsx does not route`
            )
        }
    }
})
