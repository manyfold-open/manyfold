import type { FrameworkInstallSource } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecResult } from '@manyfold/sprites'
import {
    installFrameworkVersionOn,
    type HostScriptRunner
} from '../src/modules/agents/bootstrap/framework-version-install'
import { BootstrapError } from '../src/modules/agents/bootstrap/framework-bootstrap'

interface Harness {
    run: () => Promise<string | null>
    shells: string[]
    warnings: string[]
}

// `claude --version` output shape; the probe parses the first semver token.
const versionOut = (v: string): ExecResult =>
    ({ exitCode: 0, stdout: `${v} (Claude Code)`, stderr: '' }) as ExecResult

const buildHarness = (opts: {
    version: string | null
    source: FrameworkInstallSource
    // versions the probe reports, in call order
    probes: Array<string | null>
    install: ExecResult | Error
}): Harness => {
    const shells: string[] = []
    const warnings: string[] = []
    const probes = [...opts.probes]

    const run = async (shell: string): Promise<ExecResult> => {
        if (shell.includes('npm install')) {
            shells.push(shell)
            if (opts.install instanceof Error) throw opts.install
            return opts.install
        }
        const next = probes.shift() ?? null
        return next
            ? versionOut(next)
            : ({ exitCode: 1, stdout: '', stderr: 'not found' } as ExecResult)
    }

    const runner: HostScriptRunner = {
        run,
        warn: (event) => {
            warnings.push(event)
        }
    }

    return {
        run: () =>
            installFrameworkVersionOn(
                runner,
                {
                    frameworkVersion: opts.version,
                    frameworkVersionSource: opts.source
                },
                'claude-code'
            ),
        shells,
        warnings
    }
}

// The implicit "give me latest" default must never gate agent creation on the npm
// registry being reachable — a fresh sprite already has a working CLI baked in.
test('an implicit latest install that fails keeps the image binary and creates the agent', async () => {
    const h = buildHarness({
        version: '2.1.197',
        source: 'latest',
        probes: ['2.1.92'],
        install: { exitCode: 1, stdout: '', stderr: 'ETARGET' } as ExecResult
    })
    const installed = await h.run()
    assert.equal(installed, '2.1.92')
    assert.equal(h.warnings.length, 1)
})

// A transport-level rejection (timeout / socket drop) is the same class of
// outage as a non-zero exit and must degrade the same way, not escape as a 500.
test('an implicit latest install that throws degrades instead of propagating', async () => {
    const h = buildHarness({
        version: '2.1.197',
        source: 'latest',
        probes: ['2.1.92'],
        install: new Error('exec socket closed')
    })
    assert.equal(await h.run(), '2.1.92')
})

// An asked-for version is a deliberate choice (per-agent dto or admin pin);
// silently running a different one would make the pin a lie.
for (const source of ['explicit', 'admin'] as const) {
    test(`a ${source} pin that fails to install is fatal`, async () => {
        const h = buildHarness({
            version: '2.1.197',
            source,
            probes: ['2.1.92'],
            install: { exitCode: 1, stdout: '', stderr: 'ETARGET' } as ExecResult
        })
        await assert.rejects(h.run(), (err: unknown) => {
            assert.ok(err instanceof BootstrapError)
            assert.match(err.message, /install claude-code@2\.1\.197 failed/)
            return true
        })
    })
}

// The image binary at ~/.local/bin is PATH-first. If the symlink didn't take, the
// install "succeeded" while the sprite still runs the old CLI — the exact
// silent-staleness this feature exists to remove.
test('a pinned install that does not win on PATH is fatal', async () => {
    const h = buildHarness({
        version: '2.1.197',
        source: 'admin',
        probes: ['2.1.92', '2.1.92'],
        install: { exitCode: 0, stdout: '', stderr: '' } as ExecResult
    })
    await assert.rejects(h.run(), (err: unknown) => {
        assert.ok(err instanceof BootstrapError)
        assert.match(err.message, /host reports 2\.1\.92/)
        return true
    })
})

// A pod host starts with no CLI at all (ADR-0035): an implicit-latest install
// that fails there has nothing to degrade to, so it must not report success.
test('a failed latest install is fatal on a host that has no binary to keep', async () => {
    const h = buildHarness({
        version: '2.1.197',
        source: 'latest',
        probes: [null],
        install: { exitCode: 1, stdout: '', stderr: 'E404' } as ExecResult
    })
    await assert.rejects(h.run(), (err: unknown) => {
        assert.ok(err instanceof BootstrapError)
        assert.match(err.message, /install claude-code@2\.1\.197 failed/)
        return true
    })
})

// Latency guard: re-installing a sprite that already runs the target wastes
// ~30–90s on every create for claude-code alone.
test('an already-current sprite skips the install entirely', async () => {
    const h = buildHarness({
        version: '2.1.197',
        source: 'latest',
        probes: ['2.1.197'],
        install: { exitCode: 0, stdout: '', stderr: '' } as ExecResult
    })
    assert.equal(await h.run(), '2.1.197')
    assert.deepEqual(h.shells, [])
})

// No resolvable target + no binary = an agent with no CLI at all, which would
// fail at first use. The floating dist-tag is the last resort.
test('no target and no binary installs the dist-tag rather than shipping no CLI', async () => {
    const h = buildHarness({
        version: null,
        source: 'none',
        probes: [null, '2.1.197'],
        install: { exitCode: 0, stdout: '', stderr: '' } as ExecResult
    })
    assert.equal(await h.run(), '2.1.197')
    assert.equal(h.shells.length, 1)
    assert.match(h.shells[0], /@anthropic-ai\/claude-code@latest/)
})

// With no target but a working binary there is nothing to reconcile — don't
// touch the sprite, just record what's there.
test('no target with a working binary reports it without installing', async () => {
    const h = buildHarness({
        version: null,
        source: 'none',
        probes: ['2.1.92'],
        install: { exitCode: 0, stdout: '', stderr: '' } as ExecResult
    })
    assert.equal(await h.run(), '2.1.92')
    assert.deepEqual(h.shells, [])
})

// A resolved target is not guaranteed to be installable: a dist-tag name, a ref
// like hermes' `main`, or a two-part CalVer all reach here as raw strings and
// buildNpmUpgradeShell rejects them with a plain Error, which must not escape
// the failure policy and fail an otherwise fine agent creation.
//
// A semver PRE-RELEASE is no longer in this class — `2.1.220-rc.1` and
// openclaw's `2026.7.1-2` build a shell fine now. What keeps them off an
// unsuspecting agent is the opt-in plus `latest` resolving to the newest stable,
// not an inability to install them.
test('an unusable latest dist-tag degrades instead of throwing a raw error', async () => {
    const h = buildHarness({
        version: 'main',
        source: 'latest',
        probes: ['2.1.92'],
        install: { exitCode: 0, stdout: '', stderr: '' } as ExecResult
    })
    assert.equal(await h.run(), '2.1.92')
    assert.deepEqual(h.shells, [])
    assert.equal(h.warnings.length, 1)
})

test('an unusable asked-for version is a BootstrapError, not a raw error', async () => {
    const h = buildHarness({
        version: '2026.7',
        source: 'admin',
        probes: ['2.1.92'],
        install: { exitCode: 0, stdout: '', stderr: '' } as ExecResult
    })
    await assert.rejects(h.run(), (err: unknown) => {
        assert.ok(err instanceof BootstrapError)
        assert.match(err.message, /unusable target version/)
        return true
    })
})

// The mirror of the two above: a pre-release target now builds a shell and gets
// installed, with the exact version proven against the staged manifest.
test('a pre-release target builds an install shell and is verified exactly', async () => {
    const h = buildHarness({
        version: '2.1.220-rc.1',
        source: 'admin',
        probes: ['2.1.92', '2.1.220-rc.1'],
        install: { exitCode: 0, stdout: '', stderr: '' } as ExecResult
    })

    assert.equal(await h.run(), '2.1.220-rc.1')
    assert.equal(h.shells.length, 1)
    assert.match(h.shells[0], /\[ "\$installed" = "2\.1\.220-rc\.1" \]/)
})
