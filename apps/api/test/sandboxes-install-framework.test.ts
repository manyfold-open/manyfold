import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecOptions, ExecResult, SpritesClient } from '@manyfold/sprites'
import { SandboxesService } from '../src/modules/sandboxes/sandboxes.service'

// WHY: the create form installs (or upgrades) a coding CLI on a sandbox that
// has no runtime for it yet, before the agent exists. The install must run the
// same staged npm shell as the agent-level upgrade, re-probe over the same exec
// seam, persist what it finds, and refuse to call an install "done" when the
// sprite still reports another version.

class TestSandboxes extends SandboxesService {
    execCalls: ExecOptions[] = []
    execResults: ExecResult[] = []

    protected exec(
        _client: SpritesClient,
        _spriteName: string,
        opts: ExecOptions
    ): Promise<ExecResult> {
        this.execCalls.push(opts)
        return Promise.resolve(
            this.execResults.shift() ?? { exitCode: 0, stdout: '', stderr: '' }
        )
    }

    protected spritesClientFor(): SpritesClient {
        return {} as SpritesClient
    }
}

const probeOutput = (claude: string): string =>
    [
        `claude-code=${claude}`,
        'codex=0.60.0',
        'gemini-cli=',
        'mf=0.34.0',
        ''
    ].join('\n')

const buildHarness = (opts: {
    latest?: string | null
    versions?: string[]
    catalog?: boolean
    installExit?: number
    probed?: string
}) => {
    const host = {
        id: 'sbx_1',
        userId: 'user_1',
        name: 'sandbox-1',
        spriteId: 'sprite-1',
        spriteName: 'sbx-1',
        accountId: 'spa_1',
        cliVersion: '0.34.0',
        detectedFrameworks: [],
        spriteStatus: 'warm',
        terminalEnabled: false,
        terminalModelCredentials: null,
        emptiedAt: null,
        createdAt: new Date('2026-09-10T00:00:00Z'),
        updatedAt: new Date('2026-09-11T00:00:00Z')
    }
    const persisted: { frameworks?: unknown; applied?: unknown; cli?: string } =
        {}
    const runtimes = {
        getSandboxForUser: async () => ({
            host,
            accountSlug: 'acct',
            agentsCount: 0
        }),
        setHostDetectedFrameworks: async (
            _u: string,
            _h: string,
            frameworks: unknown
        ) => {
            persisted.frameworks = frameworks
        },
        applyDetectedVersionsToHostRuntimes: async (
            _h: string,
            frameworks: unknown
        ) => {
            persisted.applied = frameworks
        },
        setSandboxCliVersion: async (_u: string, _h: string, v: string) => {
            persisted.cli = v
        }
    }
    const frameworkVersions =
        opts.catalog === false
            ? undefined
            : {
                  getForFramework: async () => ({
                      latest:
                          opts.latest === undefined ? '2.1.300' : opts.latest,
                      versions: opts.versions ?? ['2.1.300', '2.1.268'],
                      blocked: []
                  })
              }
    const svc = new TestSandboxes(
        runtimes as never,
        {} as never,
        {
            getById: async () => ({ id: 'spa_1', slug: 'acct' }),
            decryptToken: () => 'tok'
        } as never,
        {
            getCachedLatest: async () => ({
                channel: 'stable',
                version: '0.34.0'
            })
        } as never,
        {} as never,
        {} as never,
        { activeSecondsInPeriodByHost: async () => new Map() } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        frameworkVersions as never
    )
    svc.execResults.push(
        { exitCode: opts.installExit ?? 0, stdout: '', stderr: 'boom' },
        {
            exitCode: 0,
            stdout: probeOutput(opts.probed ?? '2.1.300'),
            stderr: ''
        }
    )
    return { svc, persisted }
}

test('installing a framework runs the staged npm shell for the catalog latest, re-probes, and persists what the sprite reports', async () => {
    const h = buildHarness({})
    await h.svc.installFramework('user_1', 'sbx_1', 'claude-code')
    assert.equal(h.svc.execCalls.length, 2)
    const install = h.svc.execCalls[0].cmd.join(' ')
    assert.match(install, /claude-code@2\.1\.300/)
    assert.match(h.svc.execCalls[1].cmd.join(' '), /claude --version/)
    assert.deepEqual(
        (
            h.persisted.frameworks as Array<{
                framework: string
                version: string
            }>
        ).map((f) => `${f.framework}@${f.version}`),
        ['claude-code@2.1.300', 'codex@0.60.0']
    )
    assert.equal(h.persisted.cli, '0.34.0')
})

test('an explicit target must be in the catalog; a bare "v" prefix is tolerated', async () => {
    const h = buildHarness({})
    await assert.rejects(
        h.svc.installFramework('user_1', 'sbx_1', 'claude-code', '9.9.9'),
        /not in the claude-code catalog/
    )
    const ok = buildHarness({ probed: '2.1.268' })
    await ok.svc.installFramework('user_1', 'sbx_1', 'claude-code', 'v2.1.268')
    assert.match(ok.svc.execCalls[0].cmd.join(' '), /claude-code@2\.1\.268/)
})

test('without a catalog the install falls back to npm latest and accepts whatever the sprite then reports', async () => {
    const h = buildHarness({ catalog: false, probed: '2.1.290' })
    await h.svc.installFramework('user_1', 'sbx_1', 'claude-code')
    assert.doesNotMatch(
        h.svc.execCalls[0].cmd.join(' '),
        /claude-code@2\.1\.\d+/
    )
    assert.equal(
        (h.persisted.frameworks as Array<{ version: string }>)[0].version,
        '2.1.290'
    )
})

test('a sprite that still reports the old version after the install is a failure, not a success', async () => {
    const h = buildHarness({ probed: '2.1.268' })
    await assert.rejects(
        h.svc.installFramework('user_1', 'sbx_1', 'claude-code'),
        /did not complete/
    )
    assert.equal(h.persisted.frameworks, undefined)
})

test('only the sprite image coding CLIs can be installed this way', async () => {
    const h = buildHarness({})
    await assert.rejects(
        h.svc.installFramework('user_1', 'sbx_1', 'hermes'),
        /cannot be installed on a sandbox/
    )
    assert.equal(h.svc.execCalls.length, 0)
})
