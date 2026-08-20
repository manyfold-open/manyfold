import assert from 'node:assert/strict'
import test from 'node:test'
import { HermesSpriteBootstrap } from '../src/modules/agents/bootstrap/hermes-sprite'
import {
    HERMES_PROXY_CREDENTIAL_SRC,
    HERMES_PROXY_MATCHER_SRC,
    HERMES_PROXY_UPSTREAM_HEADERS_SRC,
    renderHermesFrontProxyScript
} from '../src/modules/agents/bootstrap/hermes-front-proxy'
import type { BootstrapContext } from '../src/modules/agents/bootstrap/framework-bootstrap'

type HermesProxyRoute = 'gateway' | 'dashboard' | 'html'

const decideHermesProxyRoute = new Function(
    `return ${HERMES_PROXY_MATCHER_SRC}`
)() as (pathname: string) => HermesProxyRoute

const buildHermesUpstreamHeaders = new Function(
    `return ${HERMES_PROXY_UPSTREAM_HEADERS_SRC}`
)() as (
    headers: Record<string, string | string[] | undefined>,
    port: number,
    route: HermesProxyRoute
) => Record<string, string | string[] | undefined>

const extractHermesProxyCredential = new Function(
    `return ${HERMES_PROXY_CREDENTIAL_SRC}`
)() as (
    url: string,
    cookieHeader: string | undefined
) => { value: string; via: 'query' | 'cookie' | 'none' }

// ---------------------------------------------------------------------------
// front proxy route table — security-critical split: every HTML-serving path
// must be token-gated (hermes loopback mode injects its session token into
// index.html for any caller); /v1 must reach the gateway untouched (chat).
// ---------------------------------------------------------------------------

test('proxy route: /v1 paths go to the gateway', () => {
    assert.equal(decideHermesProxyRoute('/v1'), 'gateway')
    assert.equal(decideHermesProxyRoute('/v1/health'), 'gateway')
    assert.equal(decideHermesProxyRoute('/v1/chat/completions'), 'gateway')
})

test('proxy route: static assets and hermes-gated /api pass through', () => {
    assert.equal(decideHermesProxyRoute('/assets/index-abc.js'), 'dashboard')
    assert.equal(decideHermesProxyRoute('/fonts/foo.woff2'), 'dashboard')
    assert.equal(
        decideHermesProxyRoute('/fonts-terminal/bar.woff2'),
        'dashboard'
    )
    assert.equal(decideHermesProxyRoute('/favicon.ico'), 'dashboard')
    assert.equal(decideHermesProxyRoute('/api/status'), 'dashboard')
    assert.equal(decideHermesProxyRoute('/api/sessions'), 'dashboard')
})

test('proxy route: everything else (HTML, deep links, unknowns) requires the token', () => {
    assert.equal(decideHermesProxyRoute('/'), 'html')
    assert.equal(decideHermesProxyRoute('/index.html'), 'html')
    assert.equal(decideHermesProxyRoute('/sessions'), 'html')
    // default deny: lookalike prefixes must not slip into pass-through
    assert.equal(decideHermesProxyRoute('/v1x'), 'html')
    assert.equal(decideHermesProxyRoute('/apix'), 'html')
    assert.equal(decideHermesProxyRoute('/assets'), 'html')
})

test('rendered proxy script embeds the exact tested matcher', () => {
    const script = renderHermesFrontProxyScript()
    assert.ok(script.includes(HERMES_PROXY_MATCHER_SRC))
    assert.ok(script.includes('timingSafeEqual'))
    // upstream host rewrite — the dashboard's host-header check 400s the
    // public sprite hostname (spike 2026-07-03)
    assert.ok(script.includes("host: `127.0.0.1:${port}`"))
    assert.ok(script.includes(HERMES_PROXY_UPSTREAM_HEADERS_SRC))
    assert.ok(script.includes(HERMES_PROXY_CREDENTIAL_SRC))
    // the session cookie must never be script-readable or cross-site
    assert.ok(
        script.includes('Max-Age=2592000; Secure; HttpOnly; SameSite=Lax')
    )
})

// The SPA drops ?token= from the address bar on its first client-side
// navigation — without the cookie fallback every refresh/deep link 401s.
test('credential prefers the query token and falls back to the cookie', () => {
    assert.deepEqual(
        extractHermesProxyCredential('/?token=abc', undefined),
        { value: 'abc', via: 'query' }
    )
    assert.deepEqual(
        extractHermesProxyCredential('/chat', 'mf_dashboard_token=ck'),
        { value: 'ck', via: 'cookie' }
    )
    // a freshly minted URL must win over a stale cookie so re-opening from
    // Manyfold always re-syncs
    assert.deepEqual(
        extractHermesProxyCredential(
            '/?token=fresh',
            'mf_dashboard_token=stale'
        ),
        { value: 'fresh', via: 'query' }
    )
    assert.deepEqual(extractHermesProxyCredential('/chat', undefined), {
        value: '',
        via: 'none'
    })
})

test('credential cookie parsing is exact about the cookie name', () => {
    assert.deepEqual(
        extractHermesProxyCredential(
            '/chat',
            'a=1; mf_dashboard_token=ck; b=2'
        ),
        { value: 'ck', via: 'cookie' }
    )
    // name-prefix lookalikes and empty values must not authenticate
    assert.equal(
        extractHermesProxyCredential('/chat', 'xmf_dashboard_token=evil').via,
        'none'
    )
    assert.equal(
        extractHermesProxyCredential('/chat', 'mf_dashboard_token=').via,
        'none'
    )
    assert.equal(
        extractHermesProxyCredential('/chat', 'mf_dashboard_tokenx=evil').via,
        'none'
    )
})

// The dashboard's WS guard closes non-loopback-Origin upgrades before
// accept() — browsers send the public sprite origin, so chat/terminal WS
// died as 1006 until the proxy pinned Origin to loopback alongside Host.
// Behavioral (not string) assertions so a spread-order regression that
// lets the client's origin win again cannot pass.
test('upstream headers pin host and origin to loopback for dashboard routes', () => {
    const rewritten = buildHermesUpstreamHeaders(
        {
            host: 'art-x.sprites.app',
            origin: 'https://art-x.sprites.app',
            authorization: 'Bearer abc',
            'sec-websocket-key': 'k',
            'set-cookie': ['a=1', 'b=2']
        },
        9119,
        'dashboard'
    )
    assert.equal(rewritten.host, '127.0.0.1:9119')
    assert.equal(rewritten.origin, 'http://127.0.0.1:9119')
    assert.equal(rewritten.authorization, 'Bearer abc')
    assert.equal(rewritten['sec-websocket-key'], 'k')
    assert.deepEqual(rewritten['set-cookie'], ['a=1', 'b=2'])
})

test('upstream headers add a loopback origin when the client sent none', () => {
    const rewritten = buildHermesUpstreamHeaders(
        { host: 'art-x.sprites.app' },
        9119,
        'html'
    )
    assert.equal(rewritten.origin, 'http://127.0.0.1:9119')
})

// The gateway 403s ANY request carrying an Origin header (anti-browser
// guard, verified live 2026-07-03): injecting one broke /v1 chat through
// the proxy, so gateway-bound requests must keep Origin untouched — absent
// stays absent (server-side chat calls), public stays public (the gateway's
// own browser rejection keeps applying).
test('upstream headers leave the gateway origin untouched', () => {
    const withoutOrigin = buildHermesUpstreamHeaders(
        { host: 'art-x.sprites.app' },
        8642,
        'gateway'
    )
    assert.equal(withoutOrigin.origin, undefined)
    assert.equal(withoutOrigin.host, '127.0.0.1:8642')
    const withOrigin = buildHermesUpstreamHeaders(
        { host: 'art-x.sprites.app', origin: 'https://art-x.sprites.app' },
        8642,
        'gateway'
    )
    assert.equal(withOrigin.origin, 'https://art-x.sprites.app')
})

// ---------------------------------------------------------------------------
// enable/disable choreography — the platform allows exactly ONE http_port
// holder per sprite (PUT rejects a second), so ordering and rollback shape
// are the contract under test.
// ---------------------------------------------------------------------------

interface Call {
    op: string
    name?: string
    httpPort?: number | null
    env?: Record<string, string>
}

const clientFor = (
    calls: Call[],
    opts: { failStart?: string[] } = {}
): Record<string, unknown> => ({
    deleteService: async (_sprite: string, name: string) => {
        calls.push({ op: 'delete', name })
    },
    upsertService: async (
        _sprite: string,
        name: string,
        def: { http_port?: number; env?: Record<string, string> }
    ) => {
        calls.push({
            op: 'upsert',
            name,
            httpPort: def.http_port ?? null,
            env: def.env
        })
    },
    startService: async (_sprite: string, name: string) => {
        calls.push({ op: 'start', name })
        return {
            state: {
                status: opts.failStart?.includes(name) ? 'failed' : 'running'
            }
        }
    },
    getSprite: async () => ({ url: 'https://sprite-1.sprites.app' })
})

const ctxFor = (
    client: Record<string, unknown>,
    patch: Partial<BootstrapContext> = {}
): BootstrapContext => ({
    agentId: 'agent-1',
    runtimeId: 'runtime-1',
    userId: 'user-1',
    spriteName: 'sprite-1',
    mountPath: '/workspace',
    client: client as never,
    logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {}
    },
    envText: null,
    ...patch
})

const creds = { apiServerKey: 'k'.repeat(64), dashboardToken: 'dash-tok' }

const bootstrapFor = (
    stubs: Partial<
        Record<'buildWebUi' | 'writeProxyScript' | 'probe' | 'probeWs', boolean>
    > = {}
): HermesSpriteBootstrap & { configWrites: number } => {
    const b = new HermesSpriteBootstrap({} as never) as HermesSpriteBootstrap & {
        configWrites: number
    }
    b.configWrites = 0
    const anyB = b as never as Record<string, unknown>
    // The real writer execs into the sprite; here only the FACT that restart
    // rewrites config.yaml is under test (it is the file `hermes acp` reads
    // for the model — a credentials update that skips it changes nothing).
    anyB.writeConfigYaml = async () => {
        b.configWrites++
    }
    if (stubs.buildWebUi !== false) anyB.buildWebUi = async () => undefined
    if (stubs.writeProxyScript !== false)
        anyB.writeProxyScript = async () => undefined
    if (stubs.probe !== false) anyB.probe = async () => undefined
    if (stubs.probeWs !== false) anyB.probeWs = async () => undefined
    return b
}

const sequence = (calls: Call[]): string[] =>
    calls.map((c) =>
        c.op === 'upsert'
            ? `upsert:${c.name}:${c.httpPort === null ? 'noport' : c.httpPort}`
            : `${c.op}:${c.name}`
    )

test('enableDashboard applies the topology in port-safe order', async () => {
    const calls: Call[] = []
    const b = bootstrapFor()
    await b.enableDashboard(ctxFor(clientFor(calls)), creds)
    assert.deepEqual(sequence(calls), [
        // gateway must DROP the public port before the proxy can claim it
        'delete:hermes',
        'upsert:hermes:noport',
        'start:hermes',
        'delete:hermes-dashboard',
        'upsert:hermes-dashboard:noport',
        'start:hermes-dashboard',
        'delete:hermes-proxy',
        'upsert:hermes-proxy:18642',
        'start:hermes-proxy'
    ])
    const dashboardUpsert = calls.find(
        (c) => c.op === 'upsert' && c.name === 'hermes-dashboard'
    )
    // the dashboard service must never race the gateway for the API port,
    // and carries the session token that gates its own /api surface
    assert.equal(dashboardUpsert?.env?.API_SERVER_ENABLED, 'false')
    assert.equal(
        dashboardUpsert?.env?.HERMES_DASHBOARD_SESSION_TOKEN,
        'dash-tok'
    )
    const proxyUpsert = calls.find(
        (c) => c.op === 'upsert' && c.name === 'hermes-proxy'
    )
    assert.equal(proxyUpsert?.env?.MF_DASHBOARD_TOKEN, 'dash-tok')
})

test('enableDashboard without a persisted token fails before touching services', async () => {
    const calls: Call[] = []
    const b = bootstrapFor()
    await assert.rejects(
        () =>
            b.enableDashboard(ctxFor(clientFor(calls)), {
                apiServerKey: 'k'.repeat(64)
            }),
        /missing dashboardToken/
    )
    assert.deepEqual(calls, [])
})

test('enableDashboard rolls back to the disabled topology when the probe fails', async () => {
    const calls: Call[] = []
    const b = bootstrapFor({ probe: false })
    ;(b as never as Record<string, unknown>).probe = async () => {
        throw new Error('probe failed')
    }
    await assert.rejects(
        () => b.enableDashboard(ctxFor(clientFor(calls)), creds),
        /probe failed/
    )
    // rollback tail: tear down aux services and put the gateway back on the
    // public port so chat routing recovers
    assert.deepEqual(sequence(calls).slice(-5), [
        'delete:hermes-proxy',
        'delete:hermes-dashboard',
        'delete:hermes',
        'upsert:hermes:8642',
        'start:hermes'
    ])
})

test('enableDashboard rolls back when the WS handshake probe fails', async () => {
    const calls: Call[] = []
    const b = bootstrapFor({ probeWs: false })
    ;(b as never as Record<string, unknown>).probeWs = async () => {
        throw new Error('ws probe failed')
    }
    await assert.rejects(
        () => b.enableDashboard(ctxFor(clientFor(calls)), creds),
        /ws probe failed/
    )
    assert.deepEqual(sequence(calls).slice(-5), [
        'delete:hermes-proxy',
        'delete:hermes-dashboard',
        'delete:hermes',
        'upsert:hermes:8642',
        'start:hermes'
    ])
})

test('disableDashboard restores the gateway port first, removes the dashboard last', async () => {
    const calls: Call[] = []
    const b = bootstrapFor()
    await b.disableDashboard(ctxFor(clientFor(calls)), creds)
    assert.deepEqual(sequence(calls), [
        'delete:hermes-proxy',
        'delete:hermes',
        'upsert:hermes:8642',
        'start:hermes',
        'delete:hermes-dashboard'
    ])
})

test('disableDashboard rolls back to the FULL enabled topology when restore fails', async () => {
    const calls: Call[] = []
    const b = bootstrapFor()
    ;(b as never as Record<string, unknown>).probe = async () => {
        throw new Error('gateway never came back')
    }
    await assert.rejects(
        () => b.disableDashboard(ctxFor(clientFor(calls)), creds),
        /gateway never came back/
    )
    const seq = sequence(calls)
    // rollback re-runs the enabled dance: hermes WITHOUT the port (never two
    // http_port claimants), proxy holding the public port again, and the
    // dashboard service is NOT deleted
    assert.deepEqual(seq.slice(-9), [
        'delete:hermes',
        'upsert:hermes:noport',
        'start:hermes',
        'delete:hermes-dashboard',
        'upsert:hermes-dashboard:noport',
        'start:hermes-dashboard',
        'delete:hermes-proxy',
        'upsert:hermes-proxy:18642',
        'start:hermes-proxy'
    ])
})

test('restart keeps the plain topology when the dashboard is disabled', async () => {
    const calls: Call[] = []
    const b = bootstrapFor()
    await b.restart(ctxFor(clientFor(calls)), creds)
    assert.deepEqual(sequence(calls), [
        'delete:hermes',
        'upsert:hermes:8642',
        'start:hermes'
    ])
    assert.equal(
        b.configWrites,
        1,
        'restart must rewrite config.yaml — service env alone never reaches an ACP child'
    )
})

test('restart re-applies the full topology when the dashboard is enabled', async () => {
    const calls: Call[] = []
    const b = bootstrapFor()
    await b.restart(
        ctxFor(clientFor(calls), { dashboardEnabled: true }),
        creds
    )
    assert.deepEqual(sequence(calls), [
        'delete:hermes',
        'upsert:hermes:noport',
        'start:hermes',
        'delete:hermes-dashboard',
        'upsert:hermes-dashboard:noport',
        'start:hermes-dashboard',
        'delete:hermes-proxy',
        'upsert:hermes-proxy:18642',
        'start:hermes-proxy'
    ])
})

test('gateway service env pins HERMES_DASHBOARD_ENABLED=false even when enabled', async () => {
    // The sprite dashboard is a separate service, never gateway-managed;
    // flipping this env could trigger unvetted upstream behavior.
    const calls: Call[] = []
    const b = bootstrapFor()
    await b.restart(
        ctxFor(clientFor(calls), { dashboardEnabled: true }),
        creds
    )
    const gatewayUpsert = calls.find(
        (c) => c.op === 'upsert' && c.name === 'hermes'
    )
    assert.equal(gatewayUpsert?.env?.HERMES_DASHBOARD_ENABLED, 'false')
})
