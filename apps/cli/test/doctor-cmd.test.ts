import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram } from '../src/program'

const API = 'https://api.doctor.test/api'
const TOKEN = 'doctor-login-fixture'

// A profile name no real machine has, so `--profile` keeps the run away from
// any unit or daemon that exists outside the temp dirs.
const PROFILE = 'doctor-cmd-test'

const withSandbox = async (
    fn: (configDir: string) => Promise<void>
): Promise<void> => {
    const base = await mkdtemp(join(tmpdir(), 'mf-doctor-cmd-'))
    const configDir = join(base, 'config')
    const home = join(base, 'home')
    await mkdir(home, { recursive: true })
    const env: Record<string, string | undefined> = {
        MF_CONFIG_DIR: configDir,
        HOME: home,
        PATH: join(base, 'bin'),
        MF_PROFILE: undefined,
        MF_API_URL: undefined,
        MF_TOKEN: undefined,
        MF_API_TOKEN: undefined,
        MF_AGENT_ID: undefined
    }
    const previous = new Map<string, string | undefined>()
    for (const [key, value] of Object.entries(env)) {
        previous.set(key, process.env[key])
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
    try {
        await fn(configDir)
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        await rm(base, { recursive: true, force: true })
    }
}

const seed = async (configDir: string): Promise<void> => {
    const dir = join(configDir, 'profiles', PROFILE)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(
        join(dir, 'config.json'),
        JSON.stringify({ apiUrl: API, token: TOKEN }),
        { mode: 0o600 }
    )
}

const stubApi = (whoami: () => Response): (() => void) => {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === `${API}/health`)
            return new Response(
                JSON.stringify({ status: 'ok', db: 'ok', version: '0.0.1' }),
                { status: 200 }
            )
        if (url === `${API}/auth/whoami`) return whoami()
        return new Response('{}', { status: 404 })
    }) as typeof fetch
    return () => {
        globalThis.fetch = original
    }
}

const runDoctorCli = async (
    args: string[]
): Promise<{ out: string; err: string; exitCode: number }> => {
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
    process.exitCode = undefined
    try {
        const program = buildProgram()
        program.exitOverride()
        await program.parseAsync(['node', 'mf', ...args])
        return {
            out: out.join('\n'),
            err: err.join('\n'),
            exitCode: Number(process.exitCode ?? 0)
        }
    } finally {
        console.log = originalLog
        console.error = originalError
        process.exitCode = previousExitCode
    }
}

test('mf doctor --json reports a rejected sign-in on stdout and exits 1', async () => {
    await withSandbox(async (configDir) => {
        await seed(configDir)
        const restore = stubApi(
            () =>
                new Response(
                    JSON.stringify({
                        ok: false,
                        error: {
                            code: 'unauthorized',
                            message: 'api token expired'
                        }
                    }),
                    { status: 401 }
                )
        )
        try {
            const { out, err, exitCode } = await runDoctorCli([
                '--profile',
                PROFILE,
                'doctor',
                '--json'
            ])
            assert.equal(exitCode, 1)
            const report = JSON.parse(out) as {
                ok: boolean
                schemaVersion: number
                profiles: Array<{ name: string }>
                checks: Array<{ id: string; status: string; fix?: string }>
            }
            assert.equal(report.schemaVersion, 1)
            assert.equal(report.ok, false)
            assert.deepEqual(
                report.profiles.map((p) => p.name),
                [PROFILE]
            )
            const auth = report.checks.find((c) => c.id === 'profile.auth')
            assert.equal(auth?.status, 'fail')
            assert.equal(auth?.fix, `mf --profile ${PROFILE} login`)
            assert.equal(out.includes(TOKEN), false)
            assert.equal(err.includes(TOKEN), false)
        } finally {
            restore()
        }
    })
})

test('mf doctor exits 0 without failures and renders the human report', async () => {
    await withSandbox(async (configDir) => {
        await seed(configDir)
        const restore = stubApi(
            () =>
                new Response(
                    JSON.stringify({
                        kind: 'human-api-token',
                        userId: 'usr_1',
                        email: 'ada@example.com',
                        role: 'user'
                    }),
                    { status: 200 }
                )
        )
        try {
            const { out, exitCode } = await runDoctorCli([
                '--profile',
                PROFILE,
                'doctor'
            ])
            assert.equal(exitCode, 0)
            assert.match(out, /mf doctor/)
            assert.match(out, new RegExp(`Profile ${PROFILE} \\(current\\)`))
            assert.match(out, /0 failed/)
            assert.equal(out.includes(TOKEN), false)
        } finally {
            restore()
        }
    })
})
