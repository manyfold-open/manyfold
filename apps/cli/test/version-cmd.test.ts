import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram } from '../src/program'
import { MF_CLI_VERSION } from '../src/version'

const withConfigDir = async (
    fn: (dir: string) => Promise<void>
): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-version-cmd-'))
    const previous = new Map<string, string | undefined>()
    for (const [key, value] of Object.entries({
        MF_CONFIG_DIR: dir,
        MF_PROFILE: undefined
    })) {
        previous.set(key, process.env[key])
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
    try {
        await fn(dir)
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        await rm(dir, { recursive: true, force: true })
    }
}

const run = async (argv: string[]): Promise<string[]> => {
    const out: string[] = []
    const originalLog = console.log
    console.log = (line?: unknown) => {
        out.push(String(line ?? ''))
    }
    const previousExitCode = process.exitCode
    try {
        const program = buildProgram()
        program.exitOverride()
        await program.parseAsync(['node', 'mf', ...argv])
    } finally {
        console.log = originalLog
        process.exitCode = previousExitCode
    }
    return out
}

// install.sh compares this against the manifest version to decide whether to
// download, and performSelfUpdate re-runs the new binary to confirm the swap.
// `mf version` must therefore print exactly what `mf --version` prints.
test('mf version prints the bare version string', async () => {
    await withConfigDir(async () => {
        assert.deepEqual(await run(['version']), [MF_CLI_VERSION])
    })
})

test('mf version --json reports the build identity', async () => {
    await withConfigDir(async (dir) => {
        const lines = await run(['version', '--json'])
        const info = JSON.parse(lines.join('\n'))
        assert.equal(info.version, MF_CLI_VERSION)
        assert.equal(info.bakedChannel, 'stable')
        assert.equal(info.effectiveChannel, 'stable')
        assert.equal(info.savedChannel, null)
        // No commit or build time is baked into a source build.
        assert.equal(info.commit, null)
        assert.equal(info.installMethod, 'source')
        assert.equal(info.configDir, dir)
        assert.equal(info.profile, 'default')
        assert.equal(info.profileSource, 'channel-default')
        assert.match(info.target, /^(linux|darwin|windows)-(x64|arm64)$/)
    })
})

// The saved preference is what `mf update` follows, so that — not the baked
// channel — is what the user needs to see reported back.
test('mf version --json reports a saved dev preference as the effective channel', async () => {
    await withConfigDir(async (dir) => {
        await mkdir(dir, { recursive: true })
        await writeFile(
            join(dir, 'update-channel.json'),
            JSON.stringify({ channel: 'dev' })
        )
        const info = JSON.parse((await run(['version', '--json'])).join('\n'))
        assert.equal(info.bakedChannel, 'stable')
        assert.equal(info.savedChannel, 'dev')
        assert.equal(info.effectiveChannel, 'dev')
    })
})

test('mf version --json coerces a pre-rename staging preference to dev', async () => {
    await withConfigDir(async (dir) => {
        await mkdir(dir, { recursive: true })
        await writeFile(
            join(dir, 'update-channel.json'),
            JSON.stringify({ channel: 'staging' })
        )
        const info = JSON.parse((await run(['version', '--json'])).join('\n'))
        assert.equal(info.savedChannel, 'dev')
        assert.equal(info.effectiveChannel, 'dev')
    })
})

test('mf version --verbose names the channel, commit, target and paths', async () => {
    await withConfigDir(async (dir) => {
        const text = (await run(['version', '--verbose'])).join('\n')
        assert.match(text, new RegExp(`^mf ${MF_CLI_VERSION.replace('.', '\\.')}`))
        assert.match(text, /channel:\s+stable/)
        assert.match(text, /commit:\s+.*unknown \(source build\)/)
        assert.match(text, /target:\s+(linux|darwin|windows)-(x64|arm64)/)
        assert.match(text, /install:\s+source/)
        assert.match(text, /profile:\s+default/)
        assert.ok(text.includes(dir))
    })
})
