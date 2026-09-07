import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOpenclawConfigJson } from '../src/modules/agents/bootstrap/openclaw-shared'

// Measured on staging sprites [2026-09-07]: the sprite platform proxies the
// public ingress to the service from this address. OpenClaw >= 2026.8.1 answers
// 403 `proxy_attribution_required` — before gateway auth, on the Control UI and
// on `/v1/chat/completions` alike — when the socket peer is not trusted, so
// leaving this peer out of `trustedProxies` bricks the whole agent.
const SPRITE_INGRESS_PEER = '10.0.0.2'

const ipv4ToInt = (ip: string): number =>
    ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0)

const coversIpv4 = (entries: unknown, ip: string): boolean => {
    assert.ok(Array.isArray(entries), 'trustedProxies must be an array')
    return (entries as string[]).some((entry) => {
        const [base, bits] = entry.split('/')
        if (!base.includes('.')) return false
        const width = bits === undefined ? 32 : Number(bits)
        const mask = width === 0 ? 0 : (0xffffffff << (32 - width)) >>> 0
        return (ipv4ToInt(base) & mask) === (ipv4ToInt(ip) & mask)
    })
}

const gatewayOf = (): Record<string, unknown> =>
    JSON.parse(
        buildOpenclawConfigJson({
            gatewayPort: 18789,
            gatewayToken: 'token',
            workspacePath: '/home/sprite/.openclaw/workspace',
            controlUiEnabled: true,
            bindHost: '0.0.0.0',
            providerBaseUrl: 'https://api.openai.com/v1',
            providerApiKey: 'key',
            wireApi: 'openai-completions',
            modelName: 'gpt-4.1-mini'
        })
    ).gateway as Record<string, unknown>

test('the sprite ingress peer is a trusted proxy', () => {
    const trusted = gatewayOf().trustedProxies
    assert.ok(
        coversIpv4(trusted, SPRITE_INGRESS_PEER),
        `sprite ingress ${SPRITE_INGRESS_PEER} must be trusted, got ${JSON.stringify(trusted)}`
    )
})

test('trust stays inside the private range', () => {
    const trusted = gatewayOf().trustedProxies
    assert.equal(
        coversIpv4(trusted, '203.0.113.7'),
        false,
        'a public client address must never be trusted as a proxy'
    )
})

test('loopback stays trusted for same-host callers', () => {
    const trusted = gatewayOf().trustedProxies as string[]
    assert.ok(trusted.includes('127.0.0.1'))
    assert.ok(trusted.includes('::1'))
})
