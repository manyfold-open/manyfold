import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profilePaths } from '@manyfold/shared'
import { buildProgram } from '../src/program'

// A profile name no real machine has: `daemon status` also asks launchd /
// systemd about the profile's units.
const PROFILE = 'status-cmd-test'

const statusJson = async (
    respond: () => Response
): Promise<{ apiError?: string; daemon: unknown; out: string }> => {
    const base = await mkdtemp(join(tmpdir(), 'mf-daemon-status-'))
    const configDir = join(base, 'config')
    const home = join(base, 'home')
    await mkdir(home, { recursive: true })
    const paths = profilePaths(configDir, PROFILE)
    await mkdir(paths.daemonDir, { recursive: true, mode: 0o700 })
    await writeFile(
        paths.daemonConfigPath,
        JSON.stringify({
            apiUrl: 'https://api.status.test/api',
            token: 'ldt_status-fixture',
            daemonId: 'dh_status',
            daemonUuid: 'uuid-status',
            profile: PROFILE,
            channel: 'stable'
        }),
        { mode: 0o600 }
    )
    const previous = {
        MF_CONFIG_DIR: process.env.MF_CONFIG_DIR,
        HOME: process.env.HOME
    }
    process.env.MF_CONFIG_DIR = configDir
    process.env.HOME = home
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => respond()) as typeof fetch
    const originalLog = console.log
    const out: string[] = []
    console.log = (line?: unknown) => {
        out.push(String(line ?? ''))
    }
    try {
        const program = buildProgram()
        program.exitOverride()
        await program.parseAsync([
            'node',
            'mf',
            '--profile',
            PROFILE,
            'daemon',
            'status',
            '--json'
        ])
        const text = out.join('\n')
        return { ...(JSON.parse(text) as { daemon: unknown }), out: text }
    } finally {
        console.log = originalLog
        globalThis.fetch = originalFetch
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        await rm(base, { recursive: true, force: true })
    }
}

test('daemon status reports an API refusal without the response body', async () => {
    const page = await statusJson(
        () =>
            new Response('<html><body>Sign in to continue</body></html>', {
                status: 401
            })
    )
    assert.equal(page.daemon, null)
    assert.equal(page.apiError, 'HTTP 401')
    assert.equal(page.out.includes('Sign in to continue'), false)

    const envelope = await statusJson(
        () =>
            new Response(
                JSON.stringify({
                    ok: false,
                    error: { code: 'unauthorized', message: 'token revoked' }
                }),
                { status: 401 }
            )
    )
    assert.equal(envelope.apiError, 'HTTP 401: token revoked')
})
