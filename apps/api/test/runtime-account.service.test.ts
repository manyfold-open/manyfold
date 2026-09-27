import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import type {
    AgentRuntimeRow,
    HostDaemonRow,
    RuntimeHostRow
} from '@manyfold/db'
import { daemonOnline, type RuntimeAccountProbe } from '@manyfold/shared'
import { HostDaemonOfflineError } from '../src/modules/agents/adapters/host-daemon-access'
import {
    mergeSandboxProbe,
    RuntimeAccountService
} from '../src/modules/agent-runtimes/account/runtime-account.service'
import {
    contextOf,
    daemonRow,
    hostRow as fixtureHost,
    k8sHostRow,
    runtimeRow as fixtureRuntime,
    spritesHostRow
} from './helpers/runtime-context-fixture'

// The account view is the runtime page's contract: which state a host lands in
// (asleep / offline / upgrade-required / probe-failed / ok), that a page open
// never wakes a sandbox, that a wake always reserves the active slot first,
// and that the vendor's Retry-After is honoured by the cache. Hosts are stubs;
// the mapping under test is the service's own.

const NOW_ISO = '2026-09-03T10:00:00.000Z'

const runtimeRow = (
    overrides: Partial<AgentRuntimeRow> = {}
): AgentRuntimeRow =>
    fixtureRuntime({
        id: 'art_1',
        userId: 'user-1',
        name: 'codex',
        framework: 'codex',
        hostId: 'host-daemon',
        ...overrides
    })

const hostRow = (overrides: Partial<RuntimeHostRow> = {}): RuntimeHostRow =>
    fixtureHost({ id: 'host-daemon', userId: 'user-1', ...overrides })

const probeFor = (
    overrides: Partial<RuntimeAccountProbe> = {}
): RuntimeAccountProbe => ({
    framework: 'codex',
    checkedAt: NOW_ISO,
    credentialFacts: {
        framework: 'codex',
        authFilePresent: true,
        authFileParsed: true,
        apiKeyPresent: false,
        envApiKey: false,
        hasAccessToken: true,
        hasRefreshToken: true,
        accessTokenExp: Date.now() + 600_000,
        lastRefresh: null,
        customProviders: [],
        activeProvider: null
    },
    tokenSource: 'file',
    identity: {
        email: 'ying@example.com',
        name: null,
        organization: null,
        plan: 'pro',
        accountId: 'acct-1'
    },
    usage: {
        vendor: 'openai',
        status: 200,
        body: {
            plan_type: 'pro',
            rate_limit: {
                primary_window: {
                    used_percent: 30,
                    limit_window_seconds: 18000,
                    reset_at: 1_788_696_790
                }
            }
        },
        retryAfterSeconds: null,
        error: null,
        fetchedAt: NOW_ISO
    },
    ...overrides
})

interface Harness {
    service: RuntimeAccountService
    calls: string[]
    setRow: (row: AgentRuntimeRow | null) => void
    setHost: (host: RuntimeHostRow | null) => void
    setRpc: (fn: () => Promise<unknown>) => void
}

// The runtime with its machine and the machine's daemon, as the service
// reads them; the daemon answers the probe over RPC on every placement.
const harness = (opts: {
    row: AgentRuntimeRow | null
    host?: RuntimeHostRow | null
    daemon?: Partial<HostDaemonRow> | null
    online?: boolean
    // The plan's active-slot cap refuses the admission.
    refuseSlot?: boolean
}): Harness => {
    const calls: string[] = []
    let row = opts.row
    let host = opts.host ?? null
    let rpc: () => Promise<unknown> = async () => probeFor()
    let woken: HostDaemonRow | null = null
    const daemonFor = (): HostDaemonRow | null =>
        woken ??
        (opts.daemon === null || !host
            ? null
            : daemonRow({
                  hostId: host.id,
                  userId: host.userId,
                  clientFeatures: ['account.inspect'],
                  ...(opts.online === false
                      ? { lastSeenAt: new Date(0) }
                      : {}),
                  ...opts.daemon
              }))
    const context = {
        forRuntime: async (id: string) =>
            row && row.id === id
                ? contextOf({ runtime: row, host, daemon: daemonFor() })
                : null
    }
    const hostDaemons = {
        findByHostId: async () => daemonFor(),
        isOnline: (daemon: HostDaemonRow | null) => daemonOnline(daemon)
    }
    const runtimeAccess = {
        reserveActiveSlot: async (input: { hostId: string }) => {
            calls.push(`reserveActiveSlot:${input.hostId}`)
            if (opts.refuseSlot)
                throw new ForbiddenException({
                    code: 'CONCURRENT_ACTIVE_LIMIT_REACHED',
                    message:
                        'concurrent active sprite limit reached (1 for Free plan)'
                })
            return { plan: null, activeCount: 0, wholesale: null }
        }
    }
    // The host session (ADR-0038): a hosted machine the API holds no socket
    // to is brought up when the caller wakes; otherwise only a reachable
    // daemon answers, and the probe rides the session's rpc.
    const hostAccess = {
        withHost: async (
            args: { host: RuntimeHostRow; wake?: boolean },
            work: (session: {
                daemon: HostDaemonRow
                rpc: (call: { method: string; payload: unknown }) => Promise<unknown>
            }) => Promise<unknown>
        ) => {
            let daemon = daemonFor()
            const reachable = daemon !== null && opts.online !== false
            if (!reachable && args.host.kind === 'hosted' && args.wake !== false) {
                calls.push(`ensure:${args.host.id}`)
                woken = daemonRow({
                    hostId: args.host.id,
                    userId: args.host.userId,
                    clientFeatures: ['account.inspect']
                })
                daemon = woken
            } else if (!reachable)
                throw new HostDaemonOfflineError(args.host, 'runner_unavailable')
            return work({
                daemon: daemon!,
                rpc: async (call) => {
                    calls.push(`rpc:${call.method}:${JSON.stringify(call.payload)}`)
                    return rpc()
                }
            })
        }
    }
    const service = new RuntimeAccountService(
        context as never,
        hostDaemons as never,
        runtimeAccess as never,
        hostAccess as never
    )
    return {
        service,
        calls,
        setRow: (next) => {
            row = next
        },
        setHost: (next) => {
            host = next
        },
        setRpc: (fn) => {
            rpc = fn
        }
    }
}

test('a runtime the user does not own is a 404, not an empty view', async () => {
    const h = harness({ row: runtimeRow({ userId: 'someone-else' }) })
    await assert.rejects(
        h.service.getView('user-1', 'art_1', { wake: false }),
        NotFoundException
    )
})

test('service frameworks and non-host runtime kinds are unsupported without any probe', async () => {
    const hermes = harness({ row: runtimeRow({ framework: 'hermes' }) })
    assert.equal(
        (await hermes.service.getView('user-1', 'art_1', { wake: false }))
            .status,
        'unsupported'
    )
    const k8s = harness({
        row: runtimeRow(),
        host: k8sHostRow({ id: 'host-daemon', userId: 'user-1' })
    })
    assert.equal(
        (await k8s.service.getView('user-1', 'art_1', { wake: false })).status,
        'unsupported'
    )
    assert.deepEqual(hermes.calls, [])
    assert.deepEqual(k8s.calls, [])
})

test('daemon: offline and pre-feature daemons are named states, not probe failures', async () => {
    const offline = harness({
        row: runtimeRow(),
        host: hostRow(),
        online: false
    })
    assert.equal(
        (await offline.service.getView('user-1', 'art_1', { wake: false }))
            .status,
        'daemon-offline'
    )
    const old = harness({
        row: runtimeRow(),
        host: hostRow(),
        daemon: { clientFeatures: ['model.credential-facts'] }
    })
    assert.equal(
        (await old.service.getView('user-1', 'art_1', { wake: false })).status,
        'daemon-upgrade-required'
    )
    assert.deepEqual(offline.calls, [])
    assert.deepEqual(old.calls, [])
})

test('daemon: the probe is judged with the credential evaluator and the shared usage mapper', async () => {
    const h = harness({ row: runtimeRow(), host: hostRow() })
    const view = await h.service.getView('user-1', 'art_1', { wake: false })
    assert.deepEqual(h.calls, [
        'rpc:account.inspect:{"framework":"codex","usage":true}'
    ])
    assert.equal(view.status, 'ok')
    assert.equal(view.checkedAt, NOW_ISO)
    assert.equal(view.credentialStatus, 'valid')
    assert.equal(view.credentialReason, 'oauth-live')
    assert.equal(view.tokenSource, 'file')
    assert.equal(view.identity?.email, 'ying@example.com')
    assert.equal(view.usage?.plan, 'pro')
    assert.deepEqual(
        view.usage?.windows.map((w) => [w.key, w.usedPercent]),
        [['five_hour', 30]]
    )
    assert.equal(view.host, null)
})

test('daemon: a failing rpc becomes probe-failed with a capped message', async () => {
    const h = harness({ row: runtimeRow(), host: hostRow() })
    h.setRpc(async () => {
        throw new Error('x'.repeat(1000))
    })
    const view = await h.service.getView('user-1', 'art_1', { wake: false })
    assert.equal(view.status, 'probe-failed')
    assert.equal(view.error?.length, 300)
})

test('daemon: a payload that is not a probe is probe-failed rather than a crash', async () => {
    const h = harness({ row: runtimeRow(), host: hostRow() })
    h.setRpc(async () => ({ frameworks: [] }))
    const view = await h.service.getView('user-1', 'art_1', { wake: false })
    assert.equal(view.status, 'probe-failed')
    assert.match(view.error ?? '', /no account probe/)
})

const sandboxRow = (): AgentRuntimeRow => runtimeRow({ hostId: 'host-sb' })
const sandboxHost = (
    spriteStatus: 'cold' | 'warm' | 'running'
): RuntimeHostRow =>
    spritesHostRow({
        id: 'host-sb',
        userId: 'user-1',
        powerState:
            spriteStatus === 'cold'
                ? 'stopped'
                : spriteStatus === 'warm'
                  ? 'suspended'
                  : 'running',
        terminalEnabled: true
    })

test('sandbox: a page open never wakes a sleeping VM; a wake reserves the slot first', async () => {
    const h = harness({
        row: sandboxRow(),
        host: sandboxHost('cold'),
        daemon: null
    })
    const asleep = await h.service.getView('user-1', 'art_1', { wake: false })
    assert.equal(asleep.status, 'sandbox-asleep')
    assert.deepEqual(asleep.host, {
        powerState: 'stopped',
        terminalEnabled: true
    })
    assert.deepEqual(h.calls, [])

    const woken = await h.service.getView('user-1', 'art_1', { wake: true })
    assert.equal(woken.status, 'ok')
    assert.equal(woken.credentialStatus, 'valid')
    assert.equal(woken.usage?.windows.length, 1)
    assert.deepEqual(h.calls, [
        'reserveActiveSlot:host-sb',
        'ensure:host-sb',
        'rpc:account.inspect:{"framework":"codex","usage":true}'
    ])
})

test('sandbox: a wake refused by the active-slot cap is its own state, and is not cached', async () => {
    const h = harness({
        row: sandboxRow(),
        host: sandboxHost('cold'),
        refuseSlot: true
    })
    const refused = await h.service.getView('user-1', 'art_1', { wake: true })
    assert.equal(refused.status, 'sandbox-limit')
    assert.match(refused.error ?? '', /limit reached/)
    assert.deepEqual(h.calls, ['reserveActiveSlot:host-sb'])
    // The cap frees itself when another VM idles, so the next open asks
    // again instead of replaying the refusal.
    const peek = await h.service.getView('user-1', 'art_1', { wake: false })
    assert.equal(peek.status, 'sandbox-asleep')
})

test('sandbox: a running VM is read on a plain page open', async () => {
    const h = harness({ row: sandboxRow(), host: sandboxHost('running') })
    const view = await h.service.getView('user-1', 'art_1', { wake: false })
    assert.equal(view.status, 'ok')
    assert.equal(view.credentialStatus, 'valid')
    assert.equal(h.calls[0], 'reserveActiveSlot:host-sb')
})

test("cache: a 429 holds the view for the vendor's Retry-After, and concurrent opens share one probe", async () => {
    const h = harness({ row: runtimeRow(), host: hostRow() })
    h.setRpc(async () =>
        probeFor({
            usage: {
                vendor: 'openai',
                status: 429,
                body: null,
                retryAfterSeconds: 3600,
                error: null,
                fetchedAt: NOW_ISO
            }
        })
    )
    const [a, b] = await Promise.all([
        h.service.getView('user-1', 'art_1', { wake: false }),
        h.service.getView('user-1', 'art_1', { wake: false })
    ])
    assert.equal(a, b)
    assert.equal(a.usage?.error?.kind, 'rate-limited')
    assert.equal(h.calls.length, 1)
    h.setRpc(async () => probeFor())
    const again = await h.service.getView('user-1', 'art_1', { wake: false })
    assert.equal(again.usage?.error?.kind, 'rate-limited', 'served from cache')
    assert.equal(h.calls.length, 1)
})

// WHY: the vendors' usage endpoints rate-limit far below how often a page is
// opened or refreshed. Seen on a local stack [2026-09-11]: a second read
// within minutes returned 429 with a multi-minute Retry-After, and the page
// showed that instead of numbers.
test('usage is kept for ten minutes, re-read only on request, and a refused re-read keeps the last good numbers', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW_ISO) })
    const h = harness({ row: runtimeRow(), host: hostRow() })
    const first = await h.service.getView('user-1', 'art_1', { wake: false })
    assert.equal(first.usage?.windows.length, 1)
    assert.match(h.calls[0], /"usage":true/)
    // Past the view cache but inside the usage window: the host is asked for
    // its sign-in again, not for usage; the numbers come from the kept answer.
    t.mock.timers.tick(60_000)
    const second = await h.service.getView('user-1', 'art_1', { wake: false })
    assert.match(h.calls[1], /"usage":false/)
    assert.equal(second.usage?.windows.length, 1)
    // The menu's refresh asks the vendor again…
    const third = await h.service.getView('user-1', 'art_1', {
        wake: false,
        refreshUsage: true
    })
    assert.match(h.calls[2], /"usage":true/)
    assert.equal(third.usage?.windows.length, 1)
    // …and a refusal on that read keeps the last good numbers.
    h.setRpc(async () =>
        probeFor({
            usage: {
                vendor: 'openai',
                status: 429,
                body: null,
                retryAfterSeconds: 3600,
                error: null,
                fetchedAt: NOW_ISO
            }
        })
    )
    const fourth = await h.service.getView('user-1', 'art_1', {
        wake: false,
        refreshUsage: true
    })
    assert.match(h.calls[3], /"usage":true/)
    assert.equal(fourth.usage?.error, null)
    assert.equal(fourth.usage?.windows.length, 1)
})

test('cache: a wake request is not answered by a cached asleep view', async () => {
    const h = harness({
        row: sandboxRow(),
        host: sandboxHost('warm'),
        daemon: null
    })
    assert.equal(
        (await h.service.getView('user-1', 'art_1', { wake: false })).status,
        'sandbox-asleep'
    )
    assert.equal(
        (await h.service.getView('user-1', 'art_1', { wake: true })).status,
        'ok'
    )
})

test('mergeSandboxProbe pairs the account line with its framework facts', () => {
    const merged = mergeSandboxProbe(
        [
            JSON.stringify({
                frameworks: [
                    {
                        framework: 'claude-code',
                        credentialFacts: { framework: 'claude-code' }
                    },
                    {
                        framework: 'codex',
                        credentialFacts: {
                            framework: 'codex',
                            apiKeyPresent: true
                        }
                    }
                ]
            }),
            JSON.stringify({
                account: { framework: 'codex', tokenSource: 'none' }
            })
        ].join('\n')
    ) as Record<string, unknown>
    assert.equal(merged.framework, 'codex')
    assert.deepEqual(merged.credentialFacts, {
        framework: 'codex',
        apiKeyPresent: true
    })
    assert.equal(mergeSandboxProbe('nothing here'), null)
})

test('daemon: agy is read only from a daemon that knows it, and judged on agy’s own word', async () => {
    const agyRow = runtimeRow({ name: 'agy', framework: 'antigravity-cli' })
    const old = harness({ row: agyRow, host: hostRow() })
    assert.equal(
        (await old.service.getView('user-1', 'art_1', { wake: false })).status,
        'daemon-upgrade-required'
    )
    assert.deepEqual(old.calls, [])

    const h = harness({
        row: agyRow,
        host: hostRow(),
        daemon: { clientFeatures: [
                'account.inspect',
                'antigravity-cli.runtime-local.v1'
            ] }
    })
    h.setRpc(async () =>
        probeFor({
            framework: 'antigravity-cli',
            credentialFacts: {
                framework: 'antigravity-cli',
                tokenFilePresent: false,
                tokenFileParsed: false,
                tokenExpiresAt: null,
                hasRefreshToken: false,
                settingsApiKeyMode: false,
                envApiKey: false,
                cliSignedIn: true
            },
            tokenSource: 'none',
            identity: null,
            usage: null
        })
    )
    const view = await h.service.getView('user-1', 'art_1', { wake: false })
    assert.equal(view.status, 'ok')
    assert.equal(view.credentialStatus, 'valid')
    assert.equal(view.credentialReason, 'login-record')
})
