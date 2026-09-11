import assert from 'node:assert/strict'
import test from 'node:test'
import {
    BadRequestException,
    ServiceUnavailableException
} from '@nestjs/common'
import { SandboxesService } from '../src/modules/sandboxes/sandboxes.service'

// WHY: a bare sandbox that already has a coding CLI should take an account
// before any agent exists, and a service framework should be installable by a
// click. Both go through one call that brings an agent-less runtime up on the
// sandbox: idempotent over a live runtime, resolving the same install version
// as agent create, storing the gateway tokens a service bootstrap minted (the
// first agent cannot attach without them). The runner is left to the create
// form's own prewarm: a second starter here registered a twin runner host.

const hostWith = (detected: string[]) => ({
    id: 'sbx_1',
    userId: 'user_1',
    name: 'sandbox-1',
    spriteId: 'sprite-1',
    spriteName: 'sbx-1',
    accountId: 'spa_1',
    detectedFrameworks: detected.map((framework) => ({
        framework,
        version: '1.0.0',
        path: `~/.local/bin/${framework}`
    })),
    spriteStatus: 'warm'
})

const runtimeRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'art_prepared',
    userId: 'user_1',
    framework: 'claude-code',
    kind: 'sprites',
    status: 'ready',
    hostId: 'sbx_1',
    spriteName: 'sbx-1',
    spriteId: 'sprite-1',
    primaryAgentId: null,
    ...overrides
})

const buildHarness = (opts: {
    existing?: Array<Record<string, unknown>>
    generatedCredentials?: Record<string, string>
    crypto?: boolean
    frameworkVersions?: boolean
    detected?: string[]
}) => {
    const host = hostWith(opts.detected ?? [])
    const calls: {
        prepare: unknown[]
        inserted: unknown[]
        runner: unknown[]
        summaries: unknown[]
    } = { prepare: [], inserted: [], runner: [], summaries: [] }
    const runtimes = {
        getSandboxForUser: async () => ({
            host,
            accountSlug: 'acct',
            agentsCount: 0
        }),
        listRuntimesByHost: async () => opts.existing ?? [],
        toSummary: async (row: Record<string, unknown>) => {
            calls.summaries.push(row)
            return { id: row.id, framework: row.framework, agentsCount: 0 }
        }
    }
    const provisioner = {
        prepareRuntime: async (input: Record<string, unknown>) => {
            calls.prepare.push(input)
            return {
                runtime: runtimeRow({ framework: input.framework }),
                spritesClient: {},
                generatedCredentials: opts.generatedCredentials
            }
        }
    }
    const db = {
        insert: () => ({
            values: async (row: unknown) => {
                calls.inserted.push(row)
            }
        })
    }
    const runnerManager = {
        prepareRunner: async (args: Record<string, unknown>) => {
            calls.runner.push(args)
            return 'started'
        }
    }
    const frameworkVersions =
        opts.frameworkVersions === false
            ? undefined
            : {
                  resolveInstallVersion: async (framework: string) => ({
                      selection: {
                          version: '2.1.300',
                          source: 'latest',
                          framework
                      },
                      repo: null
                  })
              }
    const crypto =
        opts.crypto === false
            ? undefined
            : {
                  encrypt: (plain: string) => ({
                      ciphertext: `enc:${plain}`,
                      keyVersion: 1
                  })
              }
    const svc = new SandboxesService(
        runtimes as never,
        provisioner as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        db as never,
        runnerManager as never,
        frameworkVersions as never,
        crypto as never
    )
    return { svc, calls }
}

test('a framework that cannot run on a sandbox is refused before anything is touched', async () => {
    const h = buildHarness({})
    await assert.rejects(
        h.svc.prepareRuntime('user_1', 'sbx_1', 'dify'),
        BadRequestException
    )
    assert.equal(h.calls.prepare.length, 0)
})

test('a live runtime for the framework on the host is returned as is', async () => {
    const existing = runtimeRow({ id: 'art_live', status: 'ready' })
    const h = buildHarness({
        existing: [runtimeRow({ id: 'art_dead', status: 'failed' }), existing]
    })
    const summary = await h.svc.prepareRuntime('user_1', 'sbx_1', 'claude-code')
    assert.equal(summary.id, 'art_live')
    assert.equal(h.calls.prepare.length, 0)
})

test('a coding CLI gets its runtime at the resolved version; no runner is started and no credentials row is written', async () => {
    const h = buildHarness({})
    const summary = await h.svc.prepareRuntime('user_1', 'sbx_1', 'claude-code')
    assert.equal(summary.id, 'art_prepared')
    assert.deepEqual(h.calls.prepare, [
        {
            userId: 'user_1',
            framework: 'claude-code',
            hostId: 'sbx_1',
            frameworkVersion: '2.1.300',
            frameworkVersionSource: 'latest',
            frameworkRepo: null
        }
    ])
    assert.equal(h.calls.inserted.length, 0)
    assert.equal(h.calls.runner.length, 0)
})

test('a service framework stores the gateway tokens its bootstrap minted and does not start a runner', async () => {
    const h = buildHarness({
        generatedCredentials: { apiServerKey: 'k1', runtimeReportToken: 'r1' }
    })
    await h.svc.prepareRuntime('user_1', 'sbx_1', 'hermes')
    assert.equal(h.calls.runner.length, 0)
    assert.equal(h.calls.inserted.length, 1)
    const row = h.calls.inserted[0] as {
        runtimeId: string
        framework: string
        payloadCiphertext: string
    }
    assert.equal(row.runtimeId, 'art_prepared')
    assert.equal(row.framework, 'hermes')
    assert.equal(
        row.payloadCiphertext,
        `enc:${JSON.stringify({ apiServerKey: 'k1', runtimeReportToken: 'r1' })}`
    )
})

test('without credential storage a service framework is refused before provisioning', async () => {
    const h = buildHarness({ crypto: false })
    await assert.rejects(
        h.svc.prepareRuntime('user_1', 'sbx_1', 'openclaw'),
        ServiceUnavailableException
    )
    assert.equal(h.calls.prepare.length, 0)
})

test('with no version catalog the framework keeps its built-in default', async () => {
    const h = buildHarness({ frameworkVersions: false })
    await h.svc.prepareRuntime('user_1', 'sbx_1', 'codex')
    const input = h.calls.prepare[0] as {
        frameworkVersion: string | null
        frameworkVersionSource: string
    }
    assert.equal(input.frameworkVersion, null)
    assert.equal(input.frameworkVersionSource, 'none')
})

test('a CLI the sandbox already reports is registered as found, not moved to another version', async () => {
    const h = buildHarness({ detected: ['claude-code', 'codex'] })
    await h.svc.prepareRuntime('user_1', 'sbx_1', 'codex')
    const input = h.calls.prepare[0] as {
        frameworkVersion: string | null
        frameworkVersionSource: string
    }
    assert.equal(input.frameworkVersion, null)
    assert.equal(input.frameworkVersionSource, 'none')
})
