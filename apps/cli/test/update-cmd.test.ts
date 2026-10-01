import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import type { CliChannel } from '../src/channel'
import { registerUpdate, type SelfUpdateDeps } from '../src/commands/update'
import { normalizeCliError } from '../src/output'
import {
    ReleaseManifestHttpError,
    type ReleaseManifest
} from '../src/release-manifest'
import { UsageError } from '../src/usage-error'
import { spawnMf } from './fixtures/spawn-mf'

const manifest = (version: string, channel: CliChannel = 'stable'): ReleaseManifest => ({
    schema: 1,
    channel,
    version,
    commit: `${version}-commit`,
    commitShort: 'abc1234',
    buildTime: '2026-10-01T00:00:00Z',
    publishedAt: '2026-10-01T00:00:00Z',
    tag: `cli-v${version}`,
    artifacts: {}
})

const fakeDeps = (over: Partial<SelfUpdateDeps> = {}) => {
    const events: string[] = []
    const deps: SelfUpdateDeps = {
        standalone: () => true,
        resolveTarget: () => ({ os: 'darwin', arch: 'arm64' }),
        fetchManifest: async (url) => {
            events.push(`fetch ${url}`)
            return manifest('5.8.0')
        },
        loadChannelPref: async () => null,
        saveChannelPref: async (channel) => {
            events.push(`save ${channel}`)
        },
        interactive: () => false,
        confirm: async () => true,
        install: async (opts) => {
            events.push(`install ${opts.manifest.version}`)
            opts.onProgress('downloading')
            return {
                from: '5.7.0',
                to: opts.manifest.version,
                commit: opts.manifest.commit,
                execPath: '/usr/local/bin/mf',
                changed: true
            }
        },
        reportedVersion: () => '5.8.0',
        daemonPid: async () => null,
        current: { version: '5.7.0', commit: 'old-commit', channel: 'stable' },
        ...over
    }
    return { deps, events }
}

const run = async (args: string[], deps: SelfUpdateDeps) => {
    const program = new Command()
    program.exitOverride()
    registerUpdate(program, () => deps)
    const out: string[] = []
    const err: string[] = []
    const log = console.log
    const error = console.error
    console.log = (...values: unknown[]) => {
        out.push(values.map(String).join(' '))
    }
    console.error = (...values: unknown[]) => {
        err.push(values.map(String).join(' '))
    }
    const previous = process.exitCode
    process.exitCode = undefined
    let thrown: unknown
    try {
        await program.parseAsync(['node', 'mf', 'update', ...args])
    } catch (caught) {
        thrown = caught
    } finally {
        console.log = log
        console.error = error
    }
    const exitCode = process.exitCode
    process.exitCode = previous
    return { out, err, thrown, exitCode }
}

test('a source build says it cannot update itself, through the error sink', async () => {
    const { deps } = fakeDeps({ standalone: () => false })
    const human = await run([], deps)
    assert.equal(human.exitCode, 1)
    assert.match(human.err.join('\n'), /update only works on installed mf binaries/)
    assert.match(human.err.join('\n'), /In dev mode, rebuild via `pnpm build` instead\./)

    const asJson = await run(['--json'], deps)
    assert.equal(asJson.exitCode, 1)
    assert.deepEqual(asJson.out, [])
    const envelope = JSON.parse(asJson.err[0] ?? '{}')
    assert.equal(envelope.error.code, 'cli_error')
    assert.match(envelope.error.hint, /pnpm build/)
})

test('a bad --channel or --to is a usage error, and nothing is fetched or saved', async () => {
    for (const args of [
        ['--channel', 'nightly'],
        ['--to', '5.x'],
        ['--to', '5.9.0-dev.202610011200.abc1234', '--channel', 'stable']
    ]) {
        const { deps, events } = fakeDeps()
        const result = await run(args, deps)
        assert.ok(result.thrown instanceof UsageError, args.join(' '))
        assert.equal(normalizeCliError(result.thrown).exitCode, 5)
        assert.deepEqual(events, [], args.join(' '))
    }
})

test('--to a release that does not exist says where the versions are', async () => {
    const { deps, events } = fakeDeps({
        fetchManifest: async (url) => {
            throw new ReleaseManifestHttpError(url, 404)
        }
    })
    const result = await run(['--to', '9.9.9', '--channel', 'stable', '--yes'], deps)
    assert.ok(result.thrown instanceof UsageError)
    assert.match(
        result.thrown.message,
        /^no mf release 9\.9\.9; mf updates versions cli lists the versions you can install$/
    )
    assert.deepEqual(events, [])
})

test('a manifest that cannot be fetched is a network failure naming the host', async () => {
    const dns = Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), {
            code: 'ENOTFOUND'
        })
    })
    for (const failure of [
        dns,
        new DOMException('This operation was aborted', 'AbortError'),
        new TypeError('fetch failed')
    ]) {
        const { deps } = fakeDeps({
            fetchManifest: async () => {
                throw failure
            }
        })
        const result = await run(['--check'], deps)
        assert.equal(result.exitCode, 2, failure.message)
        assert.match(
            result.err.join('\n'),
            /failed to resolve the target release at github\.com/
        )
    }
})

test('a pinned channel is saved only once nobody declined', async () => {
    const declined = fakeDeps({ interactive: () => true, confirm: async () => false })
    const no = await run(['--channel', 'dev'], declined.deps)
    assert.equal(no.thrown, undefined)
    assert.deepEqual(no.out, ['cancelled.'])
    assert.equal(declined.events.some((event) => event.startsWith('save')), false)

    const accepted = fakeDeps({ interactive: () => true })
    await run(['--channel', 'dev'], accepted.deps)
    assert.deepEqual(
        accepted.events.filter((event) => !event.startsWith('fetch')),
        ['save dev', 'install 5.8.0']
    )

    const checked = fakeDeps()
    await run(['--channel', 'dev', '--check'], checked.deps)
    assert.equal(checked.events.some((event) => event.startsWith('save')), false)
})

test('--check --json and an up-to-date --json report without installing', async () => {
    const { deps, events } = fakeDeps()
    const check = await run(['--check', '--json'], deps)
    assert.deepEqual(JSON.parse(check.out.join('\n')), {
        channel: 'stable',
        current: '5.7.0',
        latest: '5.8.0',
        status: 'update'
    })

    const current = fakeDeps({
        current: { version: '5.8.0', commit: '5.8.0-commit', channel: 'stable' }
    })
    const none = await run(['--json'], current.deps)
    assert.deepEqual(JSON.parse(none.out.join('\n')), {
        channel: 'stable',
        from: '5.8.0',
        to: '5.8.0',
        changed: false
    })
    assert.equal(
        [...events, ...current.events].some((event) => event.startsWith('install')),
        false
    )
})

test('--yes --json installs with progress on stderr and the result on stdout', async () => {
    const { deps } = fakeDeps()
    const result = await run(['--yes', '--json'], deps)
    assert.equal(result.thrown, undefined)
    assert.deepEqual(JSON.parse(result.out.join('\n')), {
        channel: 'stable',
        from: '5.7.0',
        to: '5.8.0',
        commit: '5.8.0-commit',
        execPath: '/usr/local/bin/mf',
        changed: true
    })
    assert.match(result.err.join('\n'), /downloading/)
})

test('without --yes, a shell that cannot answer and every --json run are refused', async () => {
    const quiet = await run([], fakeDeps().deps)
    assert.ok(quiet.thrown instanceof UsageError)
    assert.match(quiet.thrown.message, /^non-interactive shell; pass --yes/)

    const asJson = await run(['--json'], fakeDeps({ interactive: () => true }).deps)
    assert.ok(asJson.thrown instanceof UsageError)
    assert.match(asJson.thrown.message, /^--json never prompts/)
})

test('an install that fails exits 1 with what went wrong', async () => {
    const { deps } = fakeDeps({
        install: async () => {
            throw new Error('disk full')
        }
    })
    const result = await run(['--yes'], deps)
    assert.equal(result.exitCode, 1)
    assert.match(result.err.join('\n'), /update failed: disk full/)
})

test('the real process reports a source build through the JSON envelope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-update-cmd-'))
    try {
        const child = spawnMf(['update', '--json'], { MF_CONFIG_DIR: dir })
        let out = ''
        let err = ''
        child.stdout.on('data', (chunk) => {
            out += String(chunk)
        })
        child.stderr.on('data', (chunk) => {
            err += String(chunk)
        })
        const [code] = await once(child, 'close')
        assert.equal(code, 1)
        assert.equal(out, '')
        const lines = err.trim().split('\n')
        assert.equal(lines.length, 1)
        assert.equal(JSON.parse(lines[0]).error.code, 'cli_error')
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})
