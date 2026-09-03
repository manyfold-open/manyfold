import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    parseRuntimeAccountProbe,
    runtimeAccountSupport,
    runtimeAccountUsage,
    type RuntimeAccountProbe,
    type RuntimeAccountUsageFetch
} from '../src/runtime-account'

// The host ships the vendor's usage response untouched; every judgement about
// it (which windows exist, what a status code means) lives here so the daemon
// and the sandbox script cannot disagree. These fixtures are the vendor shapes
// observed from the CLIs' own endpoints.

const probe = (usage: Partial<RuntimeAccountUsageFetch>): RuntimeAccountProbe => ({
    framework: 'codex',
    checkedAt: '2026-09-03T10:00:00.000Z',
    credentialFacts: null,
    tokenSource: 'file',
    identity: null,
    usage: {
        vendor: 'openai',
        status: 200,
        body: null,
        retryAfterSeconds: null,
        error: null,
        fetchedAt: '2026-09-03T10:00:01.000Z',
        ...usage
    }
})

describe('runtimeAccountSupport', () => {
    it('covers the coding CLIs on hosts we can reach without an agent', () => {
        assert.equal(runtimeAccountSupport('claude-code', 'daemon'), 'ok')
        assert.equal(runtimeAccountSupport('codex', 'sprites'), 'ok')
        assert.equal(runtimeAccountSupport('gemini-cli', 'daemon'), 'ok')
        assert.equal(runtimeAccountSupport('openclaw', 'daemon'), 'framework')
        assert.equal(runtimeAccountSupport('hermes', 'sprites'), 'framework')
        assert.equal(runtimeAccountSupport('claude-code', 'k8s'), 'runtime-kind')
        assert.equal(
            runtimeAccountSupport('claude-code', 'external'),
            'runtime-kind'
        )
    })
})

describe('runtimeAccountUsage: anthropic', () => {
    it('maps every utilization window in a stable order and skips extra usage', () => {
        const usage = runtimeAccountUsage(
            probe({
                vendor: 'anthropic',
                body: {
                    seven_day_opus: { utilization: 12.4, resets_at: null },
                    extra_usage: {
                        is_enabled: true,
                        utilization: 3,
                        used_credits: 1
                    },
                    seven_day: {
                        utilization: 41.6,
                        resets_at: '2026-09-08T00:00:00Z'
                    },
                    five_hour: {
                        utilization: 130,
                        resets_at: '2026-09-03T14:00:00+00:00'
                    },
                    limits: [{ kind: 'weekly_scoped' }],
                    fable_weekly: { utilization: 7 }
                }
            })
        )
        assert.ok(usage)
        assert.equal(usage.error, null)
        assert.deepEqual(
            usage.windows.map((w) => [w.key, w.usedPercent, w.windowSeconds]),
            [
                ['five_hour', 100, 18000],
                ['seven_day', 42, 604800],
                ['seven_day_opus', 12, 604800],
                ['fable_weekly', 7, null]
            ]
        )
        assert.equal(usage.windows[0].resetsAt, '2026-09-03T14:00:00.000Z')
        assert.equal(usage.windows[2].resetsAt, null)
    })
})

describe('runtimeAccountUsage: codex', () => {
    it('keys the two windows by their length and reads epoch-second resets', () => {
        const usage = runtimeAccountUsage(
            probe({
                body: {
                    plan_type: 'pro',
                    rate_limit: {
                        primary_window: {
                            used_percent: 37.2,
                            limit_window_seconds: 18000,
                            reset_at: 1_788_696_790
                        },
                        secondary_window: {
                            used_percent: 8,
                            limit_window_seconds: 604800,
                            reset_at: 1_788_696_790_000
                        }
                    }
                }
            })
        )
        assert.ok(usage)
        assert.equal(usage.plan, 'pro')
        assert.deepEqual(
            usage.windows.map((w) => [w.key, w.usedPercent, w.resetsAt]),
            [
                ['five_hour', 37, new Date(1_788_696_790_000).toISOString()],
                ['seven_day', 8, new Date(1_788_696_790_000).toISOString()]
            ]
        )
    })

    it('names an unfamiliar window by its length instead of guessing', () => {
        const usage = runtimeAccountUsage(
            probe({
                body: {
                    rate_limit: {
                        primary_window: {
                            used_percent: 1,
                            limit_window_seconds: 86400
                        }
                    }
                }
            })
        )
        assert.deepEqual(
            usage?.windows.map((w) => w.key),
            ['window_86400s']
        )
    })
})

describe('runtimeAccountUsage: gemini', () => {
    it('reports one bar per model family, pinned to the tightest bucket', () => {
        const usage = runtimeAccountUsage(
            probe({
                vendor: 'google',
                body: {
                    buckets: [
                        {
                            modelId: 'gemini-2.5-flash',
                            remainingFraction: 0.9,
                            resetTime: '2026-09-04T00:00:00Z'
                        },
                        {
                            modelId: 'gemini-2.5-flash-lite',
                            remainingFraction: 1
                        },
                        {
                            modelId: 'gemini-2.5-pro',
                            remainingFraction: 0.25,
                            resetTime: '2026-09-04T00:00:00Z'
                        },
                        {
                            modelId: 'gemini-3.5-pro',
                            remainingFraction: 0.6,
                            resetTime: '2026-09-05T00:00:00Z'
                        }
                    ]
                }
            })
        )
        assert.deepEqual(
            usage?.windows.map((w) => [w.key, w.usedPercent, w.resetsAt]),
            [
                ['gemini_pro', 75, '2026-09-04T00:00:00.000Z'],
                ['gemini_flash', 10, '2026-09-04T00:00:00.000Z'],
                ['gemini_flash_lite', 0, null]
            ]
        )
    })
})

describe('runtimeAccountUsage: failures', () => {
    it('turns the host-side outcome into one error kind the UI can name', () => {
        assert.equal(
            runtimeAccountUsage(
                probe({
                    status: 0,
                    error: { kind: 'stale-token', message: null }
                })
            )?.error?.kind,
            'stale-token'
        )
        assert.equal(
            runtimeAccountUsage(
                probe({ status: 0, error: { kind: 'timeout', message: 'x' } })
            )?.error?.kind,
            'network'
        )
        assert.equal(
            runtimeAccountUsage(probe({ status: 401 }))?.error?.kind,
            'unauthorized'
        )
        const limited = runtimeAccountUsage(
            probe({ status: 429, retryAfterSeconds: 90 })
        )
        assert.equal(limited?.error?.kind, 'rate-limited')
        assert.equal(limited?.error?.retryAfterSeconds, 90)
        const server = runtimeAccountUsage(probe({ status: 502 }))
        assert.equal(server?.error?.kind, 'unexpected')
        assert.equal(server?.error?.message, 'HTTP 502')
        assert.equal(
            runtimeAccountUsage(probe({ status: 200, body: 'not json' }))
                ?.error?.kind,
            'unexpected'
        )
    })

    it('returns no usage at all when the host made no call', () => {
        assert.equal(
            runtimeAccountUsage({ ...probe({}), usage: null }),
            null
        )
    })
})

describe('parseRuntimeAccountProbe', () => {
    it('re-validates every field and drops what it does not know', () => {
        const parsed = parseRuntimeAccountProbe({
            framework: 'claude-code',
            checkedAt: '2026-09-03T10:00:00Z',
            tokenSource: 'bogus',
            identity: {
                email: '  ying@example.com ',
                plan: 'max',
                nickname: 'dropped'
            },
            usage: {
                vendor: 'anthropic',
                status: 200,
                body: { five_hour: { utilization: 5 }, deep: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } },
                retryAfterSeconds: 'soon',
                error: { kind: 'whatever' },
                fetchedAt: 'garbage'
            },
            surprise: true
        })
        assert.ok(parsed)
        assert.equal(parsed.tokenSource, 'none')
        assert.equal(parsed.checkedAt, '2026-09-03T10:00:00.000Z')
        assert.deepEqual(parsed.identity, {
            email: 'ying@example.com',
            name: null,
            organization: null,
            plan: 'max',
            accountId: null
        })
        assert.equal(parsed.usage?.retryAfterSeconds, null)
        assert.equal(parsed.usage?.error, null)
        assert.deepEqual(Object.keys(parsed).sort(), [
            'checkedAt',
            'credentialFacts',
            'framework',
            'identity',
            'tokenSource',
            'usage'
        ])
        const body = parsed.usage?.body as Record<string, unknown>
        assert.deepEqual(body.five_hour, { utilization: 5 })
        assert.equal(
            JSON.stringify(body.deep).includes('"g":1'),
            false,
            'over-deep vendor JSON is cut, not echoed'
        )
    })

    it('rejects probes for frameworks that have no vendor account', () => {
        assert.equal(parseRuntimeAccountProbe({ framework: 'openclaw' }), null)
        assert.equal(parseRuntimeAccountProbe('claude-code'), null)
    })

    it('keeps an identity-less probe usable', () => {
        const parsed = parseRuntimeAccountProbe({
            framework: 'gemini-cli',
            identity: { email: '' },
            usage: { vendor: 'nope' }
        })
        assert.ok(parsed)
        assert.equal(parsed.identity, null)
        assert.equal(parsed.usage, null)
        assert.equal(parsed.credentialFacts, null)
    })
})
