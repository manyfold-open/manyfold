import assert from 'node:assert/strict'
import test from 'node:test'
import { ConflictException, ServiceUnavailableException } from '@nestjs/common'
import type { ExecResult } from '@manyfold/sprites'
import { SandboxesService } from '../src/modules/sandboxes/sandboxes.service'
import { HostDaemonOfflineError } from '../src/modules/agents/adapters/host-daemon-access'

// WHY: the create form installs (or upgrades) a coding CLI on a sandbox that
// has no runtime for it yet, before the agent exists. The install runs the
// same staged npm shell as the agent-level upgrade through the host daemon
// (ADR-0037 R6), re-probes over the same seam, persists what it finds on
// host_daemons and the runtimes, and refuses to call an install "done" when
// the machine still reports another version.

type ExecArgs = { cmd: string[]; stdin?: string; timeoutMs: number }

class TestSandboxes extends SandboxesService {
    execCalls: ExecArgs[] = []
    execResults: ExecResult[] = []

    protected daemonExec(): (args: ExecArgs) => Promise<ExecResult> {
        return async (args) => {
            this.execCalls.push(args)
            return this.execResults.shift() ?? { exitCode: 0, stdout: '', stderr: '' }
        }
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

// The sandbox held awake with its daemon reachable (ADR-0038): the session's
// rpc routes by the host id; a daemon the API holds no socket to is refused.
const hostAccessFor = (opts: { online?: boolean }, host: { id: string }, daemon: unknown, rpc: (args: Record<string, unknown>) => Promise<unknown>) => ({
    withHost: async (
        args: { host: { id: string } },
        work: (session: Record<string, unknown>) => Promise<unknown>
    ) => {
        if (opts.online === false)
            throw new HostDaemonOfflineError(host as never, 'runner_unavailable')
        return work({
            host: args.host,
            daemon,
            daemonId: args.host.id,
            rpc: (call: Record<string, unknown>) => rpc({ daemonId: args.host.id, ...call })
        })
    }
})

const buildHarness = (opts: {
    latest?: string | null
    versions?: string[]
    catalog?: boolean
    installExit?: number
    probed?: string
    upgradeInProgress?: boolean
    online?: boolean
}) => {
    const host = {
        id: 'sbx_1',
        userId: 'user_1',
        kind: 'hosted',
        providerId: 'rtp_1',
        providerRef: { kind: 'sprites', spriteName: 'sbx-1', spriteId: 'sprite-1' },
        name: 'sandbox-1',
        status: 'ready',
        powerState: 'suspended',
        keepAwake: false,
        terminalEnabled: false,
        terminalModelCredentials: false,
        emptiedAt: null,
        createdAt: new Date('2026-09-10T00:00:00Z'),
        updatedAt: new Date('2026-09-11T00:00:00Z')
    }
    const daemon = {
        hostId: 'sbx_1',
        cliVersion: '0.34.0',
        herdrVersion: null,
        clientFeatures: [],
        detectedFrameworks: [{ framework: 'pi', version: '1.0.0', path: '~/.local/bin/pi' }],
        lastSeenAt: new Date()
    }
    const view = { host, provider: { id: 'rtp_1', kind: 'sprites', name: 'acct' }, daemon, agentsCount: 0 }
    const persisted: { frameworks?: unknown; applied?: unknown; cli?: string } = {}
    const runtimes = {
        getSandboxForUser: async () => view,
        applyDetectedVersionsToHostRuntimes: async (
            _h: string,
            frameworks: unknown
        ) => {
            persisted.applied = frameworks
        }
    }
    const hostDaemons = {
        patch: async (_id: string, values: { detectedFrameworks?: unknown; cliVersion?: string }) => {
            persisted.frameworks = values.detectedFrameworks
            if (values.cliVersion) persisted.cli = values.cliVersion
            return null
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
        {} as never,
        {} as never,
        {} as never,
        hostDaemons as never,
        {} as never,
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
        {
            transaction: async (work: (tx: unknown) => Promise<unknown>) =>
                work({ execute: async () => [{ acquired: !opts.upgradeInProgress }] })
        } as never,
        frameworkVersions as never,
        undefined as never,
        undefined as never,
        hostAccessFor(opts, host, daemon, async () => ({})) as never
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

test('installing a framework runs the staged npm shell for the catalog latest through the daemon, re-probes, and persists what the machine reports', async () => {
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
        ['pi@1.0.0', 'claude-code@2.1.300', 'codex@0.60.0'],
        'the probed coding CLIs replace their entries; the rest of the inventory stays'
    )
    assert.equal(h.persisted.cli, '0.34.0')
    assert.ok(h.persisted.applied)
})

// The page's automatic detect reads what the daemon last reported; the
// refresh a user asks for probes the machine now, every framework through
// its own probe, and records the answers as probed.
test('a plain detect reads the reported inventory and never touches the machine', async () => {
    const h = buildHarness({})
    h.svc.execResults = []
    await h.svc.detectFrameworks('user_1', 'sbx_1')
    assert.equal(h.svc.execCalls.length, 0)
    assert.deepEqual(h.persisted.applied, [
        { framework: 'pi', version: '1.0.0', path: '~/.local/bin/pi' }
    ])
})

test('a detect the user asks for probes every framework through the daemon', async () => {
    const h = buildHarness({})
    h.svc.execResults = [
        {
            exitCode: 0,
            stdout: [
                'claude-code=2.1.300 (Claude Code)',
                'codex=',
                'gemini-cli=',
                'pi=0.90.0',
                'antigravity-cli=1.2.12',
                'openclaw=',
                'hermes=',
                'mf=0.34.0',
                ''
            ].join('\n'),
            stderr: ''
        }
    ]
    await h.svc.detectFrameworks('user_1', 'sbx_1', false, { probe: true })
    assert.equal(h.svc.execCalls.length, 1)
    const shell = h.svc.execCalls[0].cmd.join(' ')
    assert.match(shell, /claude --version/)
    assert.match(shell, /PI_OFFLINE=1 pi --version/)
    assert.match(shell, /hermes-agent" describe --tags/)
    const recorded = h.persisted.frameworks as Array<{
        framework: string
        version: string
        probedAt?: string
    }>
    assert.deepEqual(
        recorded.map((f) => `${f.framework}@${f.version}`),
        ['claude-code@2.1.300', 'pi@0.90.0', 'antigravity-cli@1.2.12']
    )
    assert.ok(
        recorded.every((f) => f.probedAt),
        'recorded as probed'
    )
    assert.ok(h.persisted.applied)
})

test('a competing framework install returns 409 before touching the machine', async () => {
    const h = buildHarness({ upgradeInProgress: true })
    await assert.rejects(h.svc.installFramework('user_1', 'sbx_1', 'claude-code'),
        (err: unknown) => err instanceof ConflictException && err.getStatus() === 409)
    assert.equal(h.svc.execCalls.length, 0)
})

test('an offline daemon refuses the install with 503', async () => {
    const h = buildHarness({ online: false })
    await assert.rejects(
        h.svc.installFramework('user_1', 'sbx_1', 'claude-code'),
        (err: unknown) =>
            err instanceof ServiceUnavailableException &&
            (err.getResponse() as { code?: string }).code === 'SANDBOX_DAEMON_OFFLINE'
    )
    assert.equal(h.svc.execCalls.length, 0)
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

test('without a catalog the install falls back to npm latest and accepts whatever the machine then reports', async () => {
    const h = buildHarness({ catalog: false, probed: '2.1.290' })
    await h.svc.installFramework('user_1', 'sbx_1', 'claude-code')
    assert.doesNotMatch(
        h.svc.execCalls[0].cmd.join(' '),
        /claude-code@2\.1\.\d+/
    )
    assert.equal(
        (h.persisted.frameworks as Array<{ framework: string; version: string }>).find(
            (f) => f.framework === 'claude-code'
        )?.version,
        '2.1.290'
    )
})

test('a machine that still reports the old version after the install is a failure, not a success', async () => {
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
