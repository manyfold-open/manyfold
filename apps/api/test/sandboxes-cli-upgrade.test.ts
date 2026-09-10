import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecOptions, ExecResult, SpritesClient } from '@manyfold/sprites'
import type { RunnerRestartOutcome } from '../src/modules/chat/runner/runner-manager.service'
import { SandboxesService } from '../src/modules/sandboxes/sandboxes.service'

// The sandbox CLI upgrade swaps ~/.local/bin/mf, but a sprite runner that is up
// keeps running — and heartbeating — the build it was started with, so every
// capability gate kept reading the old daemon while the sandbox row said the
// upgrade landed (staging 2026-09-10). These pin that the upgrade hands the
// installed version to the runner restart over the same exec seam, and that no
// restart outcome can fail an upgrade that already landed on disk.

const OLD = '0.31.2-dev.202609091242.909c84a'
const NEW = '0.33.1-dev.202609100748.ab03120'

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

interface RestartCall {
    userId: string
    spriteName: string
    installedVersion: string
    exec: (a: {
        cmd: string[]
        stdin?: string
        timeoutMs: number
    }) => Promise<ExecResult>
}

const buildHarness = (opts: {
    restartOutcome?: RunnerRestartOutcome
    installExit?: number
    installStdout?: string
}) => {
    const host = {
        id: 'sbx_1',
        userId: 'user_1',
        name: 'sandbox-1',
        spriteId: 'sprite-1',
        spriteName: 'art-1',
        accountId: 'spa_1',
        cliVersion: OLD,
        detectedFrameworks: [],
        spriteStatus: 'warm',
        terminalEnabled: false,
        terminalModelCredentials: null,
        emptiedAt: null,
        createdAt: new Date('2026-06-19T14:31:53Z'),
        updatedAt: new Date('2026-09-10T09:11:27Z')
    }
    const setVersions: string[] = []
    const restartCalls: RestartCall[] = []
    const runtimes = {
        getSandboxForUser: async () => ({
            host,
            accountSlug: 'acct',
            agentsCount: 0
        }),
        setSandboxCliVersion: async (
            _userId: string,
            _hostId: string,
            version: string
        ) => {
            setVersions.push(version)
            host.cliVersion = version
        }
    }
    const runnerManager = {
        restartForInstalledCli: async (
            call: RestartCall
        ): Promise<RunnerRestartOutcome> => {
            restartCalls.push(call)
            return opts.restartOutcome ?? 'restarted'
        }
    }
    const svc = new TestSandboxes(
        runtimes as never,
        { migrateLegacySpriteIdentities: async () => true } as never,
        {
            getById: async () => ({ id: 'spa_1', slug: 'acct' }),
            decryptToken: () => 'tok'
        } as never,
        {
            getCachedLatest: async () => ({ channel: 'dev', version: NEW })
        } as never,
        { isInstallableVersion: async () => true } as never,
        {} as never,
        { activeSecondsInPeriodByHost: async () => new Map() } as never,
        {} as never,
        {} as never,
        {} as never,
        runnerManager as never
    )
    svc.execResults.push({
        exitCode: opts.installExit ?? 0,
        stdout: opts.installStdout ?? `MF_DEV_CLI_OK\nmf-upgraded=${NEW}\n`,
        stderr: ''
    })
    return { svc, restartCalls, setVersions }
}

test('a landed install hands the installed version to the runner restart, over the same exec seam', async () => {
    const h = buildHarness({})
    const summary = await h.svc.upgradeCli('user_1', 'sbx_1')

    assert.equal(h.svc.execCalls.length, 1)
    const install = h.svc.execCalls[0].cmd.join(' ')
    assert.match(install, /install\.sh/)
    assert.match(install, /MF_CHANNEL=dev/)

    assert.deepEqual(h.setVersions, [NEW])
    assert.equal(h.restartCalls.length, 1)
    const call = h.restartCalls[0]
    assert.equal(call.userId, 'user_1')
    assert.equal(call.spriteName, 'art-1')
    assert.equal(call.installedVersion, NEW)
    // The exec the restart gets is this service's own seam, not a second
    // sprites client: what the restart runs shows up on the same call log.
    await call.exec({ cmd: ['true'], timeoutMs: 1 })
    assert.equal(h.svc.execCalls.length, 2)
    assert.deepEqual(h.svc.execCalls[1].cmd, ['true'])

    assert.equal(summary.cliVersion, NEW)
})

test('a failed install throws and never touches the runner', async () => {
    const h = buildHarness({ installExit: 1, installStdout: '' })
    await assert.rejects(
        () => h.svc.upgradeCli('user_1', 'sbx_1'),
        /did not complete/
    )
    assert.equal(h.restartCalls.length, 0)
    assert.deepEqual(h.setVersions, [])
})

test('a restart that leaves the old process running does not fail the upgrade', async () => {
    for (const outcome of ['busy', 'restart-timeout', 'failed'] as const) {
        const h = buildHarness({ restartOutcome: outcome })
        const summary = await h.svc.upgradeCli('user_1', 'sbx_1')
        assert.equal(summary.cliVersion, NEW, outcome)
        assert.equal(h.restartCalls.length, 1, outcome)
    }
})
