import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BuildInfo } from '../src/build-info'
import type { DaemonLocalHealth } from '../src/daemon/control'
import { buildPlist } from '../src/daemon/init-unit/darwin'
import { buildUnit } from '../src/daemon/init-unit/linux'
import { initUnitFileName } from '../src/daemon/init-unit'
import { runDoctor } from '../src/commands/doctor'
import { parseDaemonLogTail } from '../src/commands/doctor/gather'
import type {
    DoctorDeps,
    DoctorInput,
    DoctorReport
} from '../src/commands/doctor/types'

const API = 'https://api.test/api'
const LOGIN_TOKEN = 'stored-login-fixture'
const DAEMON_TOKEN = 'ldt_daemon-fixture'
const POSIX = process.platform !== 'win32'

interface Recorded {
    url: string
    authorization: string | null
    redirect: RequestRedirect | undefined
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    })

const HEALTHY: Route = (url) => {
    if (url.endsWith('/health'))
        return json({ status: 'ok', db: 'ok', version: '0.0.1' })
    if (url.endsWith('/auth/whoami'))
        return json({
            kind: 'human-api-token',
            userId: 'usr_1',
            email: 'ada@example.com',
            role: 'user'
        })
    if (url.endsWith('/daemon/me'))
        return json({
            data: {
                status: 'active',
                online: true,
                lastSeenAt: new Date().toISOString(),
                cliVersion: '4.2.0',
                needsUpgrade: false,
                detectedFrameworks: []
            }
        })
    return json({ error: { code: 'not_found', message: 'no route' } }, 404)
}

const recordingFetch = (route: Route = HEALTHY) => {
    const calls: Recorded[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({
            url,
            authorization: new Headers(init?.headers).get('authorization'),
            redirect: init?.redirect
        })
        return route(url, init)
    }) as typeof fetch
    return { calls, fetchImpl }
}

const build = (overrides: Partial<BuildInfo> = {}): BuildInfo => ({
    version: '4.2.0',
    bakedChannel: 'stable',
    savedChannel: null,
    effectiveChannel: 'stable',
    commit: null,
    buildTime: null,
    target: null,
    installMethod: 'source',
    execPath: '/usr/bin/node',
    configDir: '',
    profile: 'default',
    profileSource: 'channel-default',
    ...overrides
})

const withRoot = async (
    fn: (root: {
        configDir: string
        home: string
        unitDirs: { user: string; system: string }
        bin: string
    }) => Promise<void>
): Promise<void> => {
    const base = await mkdtemp(join(tmpdir(), 'mf-doctor-gather-'))
    const root = {
        configDir: join(base, 'config'),
        home: join(base, 'home'),
        unitDirs: {
            user: join(base, 'units-user'),
            system: join(base, 'units-system')
        },
        bin: join(base, 'bin')
    }
    for (const dir of [
        root.configDir,
        root.home,
        root.unitDirs.user,
        root.unitDirs.system,
        root.bin
    ])
        await mkdir(dir, { recursive: true, mode: 0o700 })
    try {
        await fn(root)
    } finally {
        await rm(base, { recursive: true, force: true })
    }
}

const seedProfile = async (
    configDir: string,
    name: string,
    opts: { apiUrl?: string; token?: string | null; daemon?: boolean } = {}
): Promise<string> => {
    const dir = join(configDir, 'profiles', name)
    await mkdir(join(dir, 'daemon'), { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    await chmod(join(dir, 'daemon'), 0o700)
    if (opts.token !== null)
        await writeFile(
            join(dir, 'config.json'),
            JSON.stringify({
                apiUrl: opts.apiUrl ?? API,
                token: opts.token ?? LOGIN_TOKEN
            }),
            { mode: 0o600 }
        )
    if (opts.daemon)
        await writeFile(
            join(dir, 'daemon', 'config.json'),
            JSON.stringify({
                apiUrl: opts.apiUrl ?? API,
                token: DAEMON_TOKEN,
                daemonId: `dh_${name}`,
                daemonUuid: `uuid-${name}`,
                profile: name,
                channel: 'stable'
            }),
            { mode: 0o600 }
        )
    return dir
}

const writeUnit = async (
    dir: string,
    profile: string,
    programArgs: string[],
    configDir?: string
): Promise<void> => {
    const ctx = {
        scope: 'user' as const,
        programArgs,
        home: '/home/test',
        user: 'test',
        group: 'test',
        errLogPath: '/tmp/daemon.err.log',
        profile,
        ...(configDir ? { configDir } : {})
    }
    await writeFile(
        join(dir, initUnitFileName(process.platform, profile)),
        process.platform === 'darwin' ? buildPlist(ctx) : buildUnit(ctx)
    )
}

const localHealth = (
    overrides: Partial<DaemonLocalHealth> = {}
): DaemonLocalHealth => ({
    status: 'running',
    pid: process.pid,
    version: '4.1.0',
    channel: 'stable',
    profile: 'default',
    daemonId: 'dh_1',
    apiUrl: API,
    startedAt: new Date().toISOString(),
    uptimeMs: 60_000,
    wsConnected: true,
    activeExecs: 0,
    activePtys: 0,
    updatePending: false,
    autoUpdate: true,
    startupMethod:
        process.platform === 'darwin' ? 'launchd-user' : 'systemd-user',
    logPath: '',
    ...overrides
})

const deps = (
    root: {
        configDir: string
        home: string
        unitDirs: { user: string; system: string }
        bin: string
    },
    overrides: Partial<DoctorDeps> = {}
): DoctorDeps => ({
    platform: process.platform,
    env: { PATH: root.bin },
    home: root.home,
    configDir: root.configDir,
    uid: process.getuid?.() ?? null,
    now: Date.now,
    fetch: recordingFetch().fetchImpl,
    timeoutMs: 2_000,
    build: build({ configDir: root.configDir }),
    stdinIsTty: true,
    readStdin: () => '',
    unitDirs: process.platform === 'win32' ? null : root.unitDirs,
    realpath: async (path) => path,
    unitStatus: async () => ({ loaded: true, active: true }),
    daemonHealth: async () => null,
    ptySupport: async () => ({ backend: 'bun' }),
    binaryVersion: async () => null,
    ...overrides
})

const input = (overrides: Partial<DoctorInput> = {}): DoctorInput => ({
    currentProfile: 'default',
    profileSource: 'channel-default',
    ...overrides
})

const check = (report: DoctorReport, id: string, profile?: string) => {
    const found = report.checks.find(
        (c) => c.id === id && (profile === undefined || c.profile === profile)
    )
    assert.ok(found, `no ${id} check${profile ? ` for ${profile}` : ''}`)
    return found
}

test('profiles are checked current first, including one only a unit knows about', async (t) => {
    if (!POSIX) return t.skip('init units are POSIX-only')
    await withRoot(async (root) => {
        await seedProfile(root.configDir, 'default')
        await seedProfile(root.configDir, 'zeta')
        await seedProfile(root.configDir, 'alpha')
        await writeUnit(root.unitDirs.user, 'orphan', [
            join(root.bin, 'mf'),
            'daemon',
            'start',
            '--foreground'
        ])
        const { calls, fetchImpl } = recordingFetch()
        const report = await runDoctor(
            deps(root, { fetch: fetchImpl }),
            input()
        )
        assert.deepEqual(
            report.profiles.map((p) => p.name),
            ['default', 'alpha', 'orphan', 'zeta']
        )
        const health = calls.filter((c) => c.url === `${API}/health`)
        assert.equal(health.length, 1, 'one /health for one URL')
        assert.equal(
            calls.filter((c) => c.url === `${API}/auth/whoami`).length,
            1,
            'one whoami for one URL and token'
        )
        assert.ok(calls.every((c) => c.redirect === 'manual'))
        assert.equal(check(report, 'daemon.process', 'orphan').status, 'fail')
        assert.equal(report.ok, false)
    })
})

test('--profile narrows the run to that profile', async () => {
    await withRoot(async (root) => {
        await seedProfile(root.configDir, 'default')
        await seedProfile(root.configDir, 'team-a')
        const report = await runDoctor(
            deps(root),
            input({ currentProfile: 'team-a', profileSource: 'flag' })
        )
        assert.deepEqual(
            report.profiles.map((p) => p.name),
            ['team-a']
        )
        assert.equal(report.ok, true)
        assert.equal(check(report, 'profile.auth', 'team-a').status, 'pass')
    })
})

test('loose modes and legacy files are found; .DS_Store is not legacy', async (t) => {
    if (!POSIX) return t.skip('modes are POSIX-only')
    await withRoot(async (root) => {
        const dir = await seedProfile(root.configDir, 'default')
        await chmod(join(dir, 'config.json'), 0o644)
        await writeFile(join(root.configDir, 'config.json'), '{}')
        await mkdir(join(root.configDir, 'daemon.staging'))
        await writeFile(join(root.configDir, '.DS_Store'), '')
        await writeFile(join(root.configDir, 'update-channel.json'), '{}')
        const report = await runDoctor(deps(root), input())
        const permissions = check(report, 'profile.permissions', 'default')
        assert.equal(permissions.status, 'warn')
        assert.match(permissions.detail, /config\.json is 0644 \(want 0600\)/)
        assert.deepEqual(check(report, 'config.legacy').data?.paths, [
            join(root.configDir, 'config.json'),
            join(root.configDir, 'daemon.staging')
        ])
    })
})

test('a black-holed API is classified as a timeout without holding the run', async () => {
    await withRoot(async (root) => {
        await seedProfile(root.configDir, 'default')
        // A real socket keeps the event loop alive until the unref'd
        // AbortSignal.timeout fires; so does this stand-in.
        const hanging = ((_: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                const socket = setTimeout(() => {}, 10_000)
                init?.signal?.addEventListener('abort', () => {
                    clearTimeout(socket)
                    reject(init.signal?.reason)
                })
            })) as typeof fetch
        const started = Date.now()
        const report = await runDoctor(
            deps(root, { fetch: hanging, timeoutMs: 50 }),
            input()
        )
        assert.ok(Date.now() - started < 5_000)
        const api = check(report, 'profile.api', 'default')
        assert.equal(api.status, 'fail')
        assert.equal(api.data?.code, 'network_timeout')
        assert.equal(check(report, 'profile.auth', 'default').status, 'skip')
    })
})

test('a probe that throws costs only its own profile', async (t) => {
    if (!POSIX) return t.skip('the control socket is a named pipe on Windows')
    await withRoot(async (root) => {
        await seedProfile(root.configDir, 'default')
        await seedProfile(root.configDir, 'broken')
        const report = await runDoctor(
            deps(root, {
                daemonHealth: async (socketPath) => {
                    if (socketPath.includes(join('profiles', 'broken')))
                        throw new Error('socket exploded')
                    return null
                }
            }),
            input()
        )
        const crashed = report.checks.filter((c) => c.profile === 'broken')
        assert.equal(crashed.length, 1)
        assert.match(crashed[0].detail, /socket exploded/)
        assert.equal(check(report, 'profile.auth', 'default').status, 'pass')
    })
})

test('no token from config, registration or log ever reaches the report', async () => {
    await withRoot(async (root) => {
        const dir = await seedProfile(root.configDir, 'default', {
            daemon: true
        })
        await writeFile(
            join(dir, 'daemon', 'daemon.log'),
            [
                '2026-09-23T10:00:00.000Z daemon starting version=4.1.0 startup=manual pid=1',
                `2026-09-23T10:00:01.000Z sent Bearer ${LOGIN_TOKEN} and ${DAEMON_TOKEN}`,
                '2026-09-23T10:00:02.000Z ws closed code=4400 reason=missing token',
                ''
            ].join('\n')
        )
        const offline: typeof fetch = recordingFetch((url) =>
            url.endsWith('/daemon/me')
                ? json({
                      status: 'active',
                      online: false,
                      lastSeenAt: '2026-09-23T09:00:00Z',
                      cliVersion: '4.1.0',
                      needsUpgrade: false
                  })
                : HEALTHY(url)
        ).fetchImpl
        const report = await runDoctor(
            deps(root, {
                fetch: offline,
                daemonHealth: async () =>
                    localHealth({ wsConnected: false, startupMethod: 'manual' })
            }),
            input({ token: { value: LOGIN_TOKEN, source: 'MF_TOKEN' } })
        )
        assert.equal(check(report, 'daemon.connection').data?.closeCode, 4400)
        const text = JSON.stringify(report)
        assert.equal(text.includes(LOGIN_TOKEN), false)
        assert.equal(text.includes(DAEMON_TOKEN), false)
    })
})

test('the daemon log tail keeps only the cause since the last connect', () => {
    const lines = (...entries: string[]) =>
        entries.map((entry) => `2026-09-23T10:00:00.000Z ${entry}`).join('\n')
    assert.deepEqual(
        parseDaemonLogTail(
            lines(
                'ws closed code=4403 reason=daemon revoked',
                'daemon starting version=4.2.0 startup=launchd-user pid=7',
                'ws connected',
                'ws closed code=1006 reason=Failed to connect',
                'reconnecting in 30000ms'
            )
        ),
        { kind: 'close', code: 1006, connectFailed: true }
    )
    assert.equal(
        parseDaemonLogTail(
            lines('ws closed code=1012 reason=service restart', 'ws connected')
        ),
        null
    )
    assert.deepEqual(
        parseDaemonLogTail(
            lines('ws connect failed: Error: Unexpected server response: 400')
        ),
        { kind: 'unexpected-response', status: 400 }
    )
})

test('a web page at the API URL leads to the /api it should have been', async () => {
    await withRoot(async (root) => {
        await seedProfile(root.configDir, 'default', {
            apiUrl: 'https://mf.example.com'
        })
        const { calls, fetchImpl } = recordingFetch((url) =>
            url === 'https://mf.example.com/api/health'
                ? json({ status: 'ok', db: 'ok', version: '0.0.1' })
                : new Response('<html></html>', { status: 200 })
        )
        const report = await runDoctor(
            deps(root, { fetch: fetchImpl }),
            input()
        )
        const api = check(report, 'profile.api', 'default')
        assert.equal(api.fix, 'mf login --api-url https://mf.example.com/api')
        assert.equal(
            calls.find((c) => c.url === 'https://mf.example.com/api/health')
                ?.authorization,
            null
        )
    })
})

test('overrides: a URL alone is probed without credentials; --token - needs stdin', async () => {
    await withRoot(async (root) => {
        await seedProfile(root.configDir, 'default')
        const { calls, fetchImpl } = recordingFetch()
        const report = await runDoctor(
            deps(root, { fetch: fetchImpl }),
            input({
                apiUrl: {
                    value: 'https://other.test/api',
                    source: 'MF_API_URL'
                }
            })
        )
        assert.equal(check(report, 'config.overrides').status, 'pass')
        assert.ok(
            calls
                .filter((c) => c.url.startsWith('https://other.test'))
                .every((c) => c.authorization === null)
        )

        const tty = await runDoctor(
            deps(root),
            input({ token: { value: '-', source: 'flag' } })
        )
        assert.equal(check(tty, 'config.overrides').status, 'skip')

        const piped = recordingFetch()
        const fromStdin = await runDoctor(
            deps(root, {
                fetch: piped.fetchImpl,
                stdinIsTty: false,
                readStdin: () => 'piped-token-fixture\n'
            }),
            input({ token: { value: '-', source: 'flag' } })
        )
        assert.equal(check(fromStdin, 'config.overrides').status, 'pass')
        assert.ok(
            piped.calls.some(
                (c) => c.authorization === 'Bearer piped-token-fixture'
            )
        )
    })
})

test('daemons sharing one program run its --version once', async (t) => {
    if (!POSIX) return t.skip('init units are POSIX-only')
    await withRoot(async (root) => {
        const program = join(root.bin, 'mf')
        await writeFile(program, '#!/bin/sh\n', { mode: 0o755 })
        for (const name of ['default', 'accept']) {
            await seedProfile(root.configDir, name, { daemon: true })
            // accept's unit predates MF_CONFIG_DIR in units: its daemon
            // reads the default dir, not this one.
            await writeUnit(
                root.unitDirs.user,
                name,
                [program, 'daemon', 'start', '--foreground'],
                name === 'default' ? root.configDir : undefined
            )
        }
        let spawned = 0
        const report = await runDoctor(
            deps(root, {
                daemonHealth: async () => localHealth({ version: '4.1.0' }),
                binaryVersion: async () => {
                    spawned += 1
                    return '4.2.0'
                }
            }),
            input()
        )
        assert.equal(spawned, 1)
        for (const name of ['default', 'accept'])
            assert.equal(check(report, 'daemon.version', name).status, 'warn')
        assert.equal(
            check(report, 'daemon.autostart', 'default').status,
            'pass'
        )
        const stale = check(report, 'daemon.autostart', 'accept')
        assert.equal(stale.status, 'warn')
        assert.equal(
            stale.data?.unitConfigDir,
            join(root.home, '.manyfold')
        )
    })
})
