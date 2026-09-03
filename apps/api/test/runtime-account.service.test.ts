import assert from 'node:assert/strict'
import test from 'node:test'
import { NotFoundException } from '@nestjs/common'
import type { AgentRuntimeRow, RuntimeHostRow } from '@manyfold/db'
import type { ExecOptions, ExecResult, SpritesClient } from '@manyfold/sprites'
import type { RuntimeAccountProbe } from '@manyfold/shared'
import {
    mergeSandboxProbe,
    RuntimeAccountService
} from '../src/modules/agent-runtimes/account/runtime-account.service'

// The account view is the runtime page's contract: which state a host lands in
// (asleep / offline / upgrade-required / probe-failed / ok), that a page open
// never wakes a sandbox, that a wake always reserves the active slot first,
// and that the vendor's Retry-After is honoured by the cache. Hosts are stubs;
// the mapping under test is the service's own.

const NOW_ISO = '2026-09-03T10:00:00.000Z'

const runtimeRow = (overrides: Partial<AgentRuntimeRow> = {}): AgentRuntimeRow =>
    ({
        id: 'art_1',
        userId: 'user-1',
        name: 'codex',
        framework: 'codex',
        kind: 'daemon',
        status: 'ready',
        daemonId: 'host-daemon',
        hostId: null,
        accountId: null,
        spriteName: null,
        ...overrides
    }) as AgentRuntimeRow

const hostRow = (overrides: Partial<RuntimeHostRow> = {}): RuntimeHostRow =>
    ({
        id: 'host-daemon',
        userId: 'user-1',
        kind: 'daemon',
        status: 'active',
        clientFeatures: ['account.inspect'],
        spriteStatus: null,
        terminalEnabled: false,
        spriteName: null,
        accountId: null,
        ...overrides
    }) as RuntimeHostRow

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
    execs: ExecOptions[]
    setRow: (row: AgentRuntimeRow | null) => void
    setHost: (host: RuntimeHostRow | null) => void
    setRpc: (fn: () => Promise<unknown>) => void
    setExecOutput: (stdout: string) => void
}

const harness = (opts: {
    row: AgentRuntimeRow | null
    host?: RuntimeHostRow | null
    online?: boolean
}): Harness => {
    const calls: string[] = []
    const execs: ExecOptions[] = []
    let row = opts.row
    let host = opts.host ?? null
    let rpc: () => Promise<unknown> = async () => probeFor()
    let execStdout = ''
    class TestService extends RuntimeAccountService {
        protected spritesClientFor(): SpritesClient {
            calls.push('spritesClientFor')
            return {} as SpritesClient
        }
        protected exec(
            _client: SpritesClient,
            spriteName: string,
            options: ExecOptions
        ): Promise<ExecResult> {
            calls.push(`exec:${spriteName}`)
            execs.push(options)
            return Promise.resolve({
                exitCode: 0,
                stdout: execStdout,
                stderr: ''
            })
        }
    }
    const runtimes = {
        findById: async (id: string) => (row && row.id === id ? row : null),
        findHostById: async (id: string) => (host && host.id === id ? host : null)
    }
    const daemonHosts = {
        findById: async (id: string) => (host && host.id === id ? host : null),
        isOnline: () => opts.online ?? true
    }
    const daemonRegistry = {
        rpc: async (args: { method: string; payload: unknown }) => {
            calls.push(`rpc:${args.method}:${JSON.stringify(args.payload)}`)
            return rpc()
        }
    }
    const accounts = {
        getById: async (id: string) => ({ id, slug: 'acct', token: 'x' }),
        decryptToken: () => 'token'
    }
    const runtimeAccess = {
        reserveActiveSlot: async (input: { hostId: string }) => {
            calls.push(`reserveActiveSlot:${input.hostId}`)
            return { plan: null, activeCount: 0, wholesale: null }
        }
    }
    const service = new TestService(
        runtimes as never,
        daemonHosts as never,
        daemonRegistry as never,
        accounts as never,
        runtimeAccess as never
    )
    return {
        service,
        calls,
        execs,
        setRow: (next) => {
            row = next
        },
        setHost: (next) => {
            host = next
        },
        setRpc: (fn) => {
            rpc = fn
        },
        setExecOutput: (stdout) => {
            execStdout = stdout
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
        (await hermes.service.getView('user-1', 'art_1', { wake: false })).status,
        'unsupported'
    )
    const k8s = harness({ row: runtimeRow({ kind: 'k8s' }) })
    assert.equal(
        (await k8s.service.getView('user-1', 'art_1', { wake: false })).status,
        'unsupported'
    )
    assert.deepEqual(hermes.calls, [])
    assert.deepEqual(k8s.calls, [])
})

test('daemon: offline and pre-feature daemons are named states, not probe failures', async () => {
    const offline = harness({ row: runtimeRow(), host: hostRow(), online: false })
    assert.equal(
        (await offline.service.getView('user-1', 'art_1', { wake: false })).status,
        'daemon-offline'
    )
    const old = harness({
        row: runtimeRow(),
        host: hostRow({ clientFeatures: ['model.credential-facts'] })
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
    assert.deepEqual(h.calls, ['rpc:account.inspect:{"framework":"codex"}'])
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

const sandboxRow = (): AgentRuntimeRow =>
    runtimeRow({ kind: 'sprites', daemonId: null, hostId: 'host-sb' })
const sandboxHost = (spriteStatus: 'cold' | 'warm' | 'running'): RuntimeHostRow =>
    hostRow({
        id: 'host-sb',
        kind: 'sandbox',
        spriteStatus,
        spriteName: 'art-1',
        accountId: 'spa_1',
        terminalEnabled: true
    })

test('sandbox: a page open never wakes a sleeping VM; a wake reserves the slot first', async () => {
    const h = harness({ row: sandboxRow(), host: sandboxHost('cold') })
    const asleep = await h.service.getView('user-1', 'art_1', { wake: false })
    assert.equal(asleep.status, 'sandbox-asleep')
    assert.deepEqual(asleep.host, { spriteStatus: 'cold', terminalEnabled: true })
    assert.deepEqual(h.calls, [])

    h.setExecOutput(
        [
            'noise from bash profile',
            JSON.stringify({
                frameworks: [
                    {
                        framework: 'codex',
                        credentialFacts: probeFor().credentialFacts
                    }
                ]
            }),
            JSON.stringify({
                account: { ...probeFor(), credentialFacts: undefined }
            })
        ].join('\n')
    )
    const woken = await h.service.getView('user-1', 'art_1', { wake: true })
    assert.equal(woken.status, 'ok')
    assert.equal(woken.credentialStatus, 'valid')
    assert.equal(woken.usage?.windows.length, 1)
    assert.deepEqual(h.calls, [
        'reserveActiveSlot:host-sb',
        'spritesClientFor',
        'exec:art-1'
    ])
    const [exec] = h.execs
    assert.deepEqual(exec.cmd.slice(0, 2), ['bash', '-lc'])
    // One exec carries both scripts: the facts and the account probe.
    assert.match(exec.cmd[2], /MF_MODEL_INSPECT_NODE/)
    assert.match(exec.cmd[2], /MF_ACCOUNT_INSPECT_NODE/)
})

test('sandbox: a running VM is read on a plain page open', async () => {
    const h = harness({ row: sandboxRow(), host: sandboxHost('running') })
    h.setExecOutput(
        JSON.stringify({ account: { ...probeFor(), credentialFacts: undefined } })
    )
    const view = await h.service.getView('user-1', 'art_1', { wake: false })
    assert.equal(view.status, 'ok')
    // No facts line: the evaluator fails open rather than calling it missing.
    assert.equal(view.credentialStatus, 'unknown')
    assert.equal(view.credentialReason, 'not-reported')
    assert.equal(h.calls[0], 'reserveActiveSlot:host-sb')
})

test('cache: a 429 holds the view for the vendor\'s Retry-After, and concurrent opens share one probe', async () => {
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

test('cache: a wake request is not answered by a cached asleep view', async () => {
    const h = harness({ row: sandboxRow(), host: sandboxHost('warm') })
    h.setExecOutput(
        JSON.stringify({ account: { ...probeFor(), credentialFacts: undefined } })
    )
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
                    { framework: 'claude-code', credentialFacts: { framework: 'claude-code' } },
                    { framework: 'codex', credentialFacts: { framework: 'codex', apiKeyPresent: true } }
                ]
            }),
            JSON.stringify({ account: { framework: 'codex', tokenSource: 'none' } })
        ].join('\n')
    ) as Record<string, unknown>
    assert.equal(merged.framework, 'codex')
    assert.deepEqual(merged.credentialFacts, { framework: 'codex', apiKeyPresent: true })
    assert.equal(mergeSandboxProbe('nothing here'), null)
})
