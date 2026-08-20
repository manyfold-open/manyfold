import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram } from '../src/program'

const withConfigDir = async (
    fn: (dir: string) => Promise<void>
): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-profile-cmd-'))
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

const seedProfile = async (
    dir: string,
    name: string,
    opts: { token?: string; apiUrl?: string; daemon?: boolean } = {}
): Promise<void> => {
    const profileDir = join(dir, 'profiles', name)
    await mkdir(profileDir, { recursive: true })
    await writeFile(
        join(profileDir, 'config.json'),
        JSON.stringify({
            apiUrl: opts.apiUrl ?? 'https://api.test/api',
            token: opts.token ?? 'mfs_token'
        })
    )
    if (opts.daemon) {
        await mkdir(join(profileDir, 'daemon'), { recursive: true })
        await writeFile(
            join(profileDir, 'daemon', 'config.json'),
            JSON.stringify({
                apiUrl: opts.apiUrl ?? 'https://api.test/api',
                token: 'ldt_x',
                daemonId: 'ldh_x',
                daemonUuid: 'uuid',
                profile: name,
                channel: 'stable'
            })
        )
    }
}

// Success payloads print to stdout, `fail --json` prints to stderr — capture
// both and parse whichever side produced output.
const runJson = async (argv: string[]): Promise<unknown> => {
    const out: string[] = []
    const err: string[] = []
    const originalLog = console.log
    const originalError = console.error
    console.log = (line?: unknown) => {
        out.push(String(line ?? ''))
    }
    console.error = (line?: unknown) => {
        err.push(String(line ?? ''))
    }
    const previousExitCode = process.exitCode
    try {
        const program = buildProgram()
        program.exitOverride()
        await program.parseAsync(['node', 'mf', ...argv])
    } finally {
        console.log = originalLog
        console.error = originalError
        process.exitCode = previousExitCode
    }
    return JSON.parse((out.length > 0 ? out : err).join('\n'))
}

test('profile list enumerates profile dirs and marks the current one', async () => {
    await withConfigDir(async (dir) => {
        await seedProfile(dir, 'staging', { daemon: true })
        await seedProfile(dir, 'team-a')
        const result = (await runJson(['profile', 'list', '--json'])) as {
            profiles: Array<{
                name: string
                current: boolean
                loggedIn: boolean
                daemonRegistered: boolean
            }>
        }
        const names = result.profiles.map((p) => p.name)
        // `default` appears even without a dir: it is the current profile
        assert.deepEqual(names, ['default', 'staging', 'team-a'])
        const byName = new Map(result.profiles.map((p) => [p.name, p]))
        assert.equal(byName.get('default')?.current, true)
        assert.equal(byName.get('default')?.loggedIn, false)
        assert.equal(byName.get('staging')?.daemonRegistered, true)
        assert.equal(byName.get('team-a')?.daemonRegistered, false)
    })
})

test('profile show reports source, paths and login state', async () => {
    await withConfigDir(async (dir) => {
        await seedProfile(dir, 'team-a', { apiUrl: 'https://api.a.test/api' })
        const shown = (await runJson([
            '--profile',
            'team-a',
            'profile',
            'show',
            '--json'
        ])) as {
            name: string
            source: string
            apiUrl: string
            loggedIn: boolean
            configPath: string
        }
        assert.equal(shown.name, 'team-a')
        assert.equal(shown.source, 'flag')
        assert.equal(shown.apiUrl, 'https://api.a.test/api')
        assert.equal(shown.loggedIn, true)
        assert.equal(
            shown.configPath,
            `${dir}/profiles/team-a/config.json`
        )
    })
})

test('profile delete removes the control plane and never touches agent data', async () => {
    await withConfigDir(async (dir) => {
        await seedProfile(dir, 'team-a', { daemon: true })
        // ADR-0014: the data plane is machine-scoped and shared — deleting a
        // profile must leave it alone by construction.
        const sharedWorkspace = join(dir, 'workspaces', 'agt_1')
        await mkdir(sharedWorkspace, { recursive: true })
        const result = (await runJson([
            'profile',
            'delete',
            'team-a',
            '--yes',
            '--json'
        ])) as { ok: boolean; removed: string[] }
        assert.equal(result.ok, true)
        assert.deepEqual(result.removed, [`${dir}/profiles/team-a`])
        const entries = await readdir(join(dir, 'profiles'))
        assert.deepEqual(entries, [])
        assert.ok(await stat(sharedWorkspace))
    })
})

test('profile delete refuses default without --force and rejects bad names', async () => {
    await withConfigDir(async () => {
        const denied = (await runJson([
            'profile',
            'delete',
            'default',
            '--yes',
            '--json'
        ])) as { error: { message: string } }
        assert.match(denied.error.message, /refusing to delete the 'default'/)

        const invalid = (await runJson([
            'profile',
            'delete',
            '../pwn',
            '--yes',
            '--json'
        ])) as { error: { message: string } }
        assert.match(invalid.error.message, /invalid profile name/)
    })
})
