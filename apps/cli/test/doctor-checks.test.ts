import test from 'node:test'
import assert from 'node:assert/strict'
import type { BuildInfo } from '../src/build-info'
import type { DaemonLocalHealth } from '../src/daemon/control'
import { machineChecks } from '../src/commands/doctor/machine-checks'
import { profileChecks } from '../src/commands/doctor/profile-checks'
import type {
    CheckId,
    DoctorCheck,
    DoctorContext,
    HttpFact,
    MachineFacts,
    ProfileFacts,
    UnitFact
} from '../src/commands/doctor/types'

const NOW = Date.parse('2026-09-23T12:00:00Z')
const MF = '/Users/test/.local/bin/mf'

const build = (overrides: Partial<BuildInfo> = {}): BuildInfo => ({
    version: '4.2.0',
    bakedChannel: 'stable',
    savedChannel: null,
    effectiveChannel: 'stable',
    commit: 'abc1234',
    buildTime: null,
    target: 'darwin-arm64',
    installMethod: 'standalone',
    execPath: MF,
    configDir: '/Users/test/.manyfold',
    profile: 'default',
    profileSource: 'channel-default',
    ...overrides
})

const machine = (overrides: Partial<MachineFacts> = {}): MachineFacts => ({
    build: build(),
    update: {
        kind: 'checked',
        channel: 'stable',
        current: '4.2.0',
        latest: '4.2.0',
        status: 'up-to-date'
    },
    self: MF,
    mfOnPath: [{ path: MF, realpath: MF }],
    overrides: {
        apiUrl: null,
        token: null,
        stdinUnavailable: false,
        targetUrl: null,
        probe: null
    },
    terminal: { backend: 'bun' },
    frameworks: [
        { framework: 'claude-code', path: '/opt/homebrew/bin/claude' }
    ],
    hooks: [],
    hooksError: null,
    ...overrides
})

const context = (overrides: Partial<DoctorContext> = {}): DoctorContext => ({
    currentProfile: 'default',
    profileSource: 'channel-default',
    bakedChannel: 'stable',
    platform: 'darwin',
    now: NOW,
    anyRegistration: true,
    ...overrides
})

const HEALTH_OK: HttpFact = {
    kind: 'ok',
    status: 200,
    body: { status: 'ok', db: 'ok', version: '0.0.1' }
}

const localHealth = (
    overrides: Partial<DaemonLocalHealth> = {}
): DaemonLocalHealth => ({
    status: 'running',
    pid: 4242,
    version: '4.2.0',
    channel: 'stable',
    profile: 'default',
    daemonId: 'dh_1',
    apiUrl: 'https://api.test/api',
    startedAt: '2026-09-23T10:00:00Z',
    uptimeMs: 7_200_000,
    wsConnected: true,
    activeExecs: 0,
    activePtys: 0,
    updatePending: false,
    autoUpdate: true,
    startupMethod: 'launchd-user',
    logPath: '/cfg/profiles/default/daemon/daemon.log',
    ...overrides
})

const unit = (
    scope: 'user' | 'system',
    overrides: Partial<UnitFact> = {}
): UnitFact => ({
    scope,
    path: `/units/${scope}/ai.manyfold.daemon.default.plist`,
    installed: false,
    loaded: false,
    active: false,
    invocation: null,
    programExists: null,
    programRealpath: null,
    ...overrides
})

const LIVE_UNIT = unit('user', {
    installed: true,
    loaded: true,
    active: true,
    invocation: [MF],
    programExists: true,
    programRealpath: MF
})

const profile = (overrides: Partial<ProfileFacts> = {}): ProfileFacts => {
    const name = overrides.name ?? 'default'
    return {
        name,
        current: true,
        dirExists: true,
        paths: {
            dir: `/cfg/profiles/${name}`,
            configPath: `/cfg/profiles/${name}/config.json`,
            daemonDir: `/cfg/profiles/${name}/daemon`,
            daemonConfigPath: `/cfg/profiles/${name}/daemon/config.json`,
            errLogPath: `/cfg/profiles/${name}/daemon/daemon.err.log`
        },
        config: {
            state: 'ok',
            value: { apiUrl: 'https://api.test/api', token: 'stored-login' }
        },
        registration: { state: 'missing' },
        permissionIssues: [],
        apiUrl: 'https://api.test/api',
        api: HEALTH_OK,
        apiSuggestion: null,
        auth: {
            kind: 'ok',
            status: 200,
            body: {
                kind: 'human-api-token',
                userId: 'usr_1',
                email: 'ada@example.com',
                role: 'user'
            }
        },
        pid: null,
        health: null,
        units: { user: unit('user'), system: unit('system') },
        daemonMe: null,
        logCause: null,
        onDisk: null,
        ...overrides
    }
}

const hostSummary = (overrides: Record<string, unknown> = {}): HttpFact => ({
    kind: 'ok',
    status: 200,
    body: {
        status: 'active',
        online: true,
        lastSeenAt: '2026-09-23T11:59:50Z',
        cliVersion: '4.2.0',
        needsUpgrade: false,
        detectedFrameworks: [
            {
                framework: 'claude-code',
                version: '2.0.0',
                path: '/opt/homebrew/bin/claude'
            }
        ],
        ...overrides
    }
})

const registered = (overrides: Partial<ProfileFacts> = {}): ProfileFacts =>
    profile({
        registration: {
            state: 'ok',
            value: {
                apiUrl: 'https://api.test/api',
                token: 'ldt_daemon',
                daemonId: 'dh_1',
                daemonUuid: 'uuid-1',
                profile: overrides.name ?? 'default',
                channel: 'stable'
            }
        },
        health: localHealth(),
        pid: 4242,
        units: { user: LIVE_UNIT, system: unit('system') },
        daemonMe: hostSummary(),
        onDisk: { version: '4.2.0', path: MF },
        ...overrides
    })

const find = (checks: DoctorCheck[], id: CheckId): DoctorCheck => {
    const check = checks.find((c) => c.id === id)
    assert.ok(check, `no ${id} check`)
    return check
}

const run = (
    p: ProfileFacts,
    opts: {
        all?: ProfileFacts[]
        machine?: MachineFacts
        ctx?: Partial<DoctorContext>
    } = {}
): DoctorCheck[] =>
    profileChecks(
        p,
        opts.all ?? [p],
        opts.machine ?? machine(),
        context(opts.ctx)
    )

test('a signed-in profile with a healthy daemon passes every check', () => {
    const checks = run(registered())
    assert.deepEqual(
        checks.filter((c) => c.status !== 'pass').map((c) => c.id),
        []
    )
    assert.match(find(checks, 'profile.auth').detail, /ada@example\.com/)
    assert.deepEqual(
        machineChecks(machine(), context())
            .filter((c) => c.status !== 'pass' && c.status !== 'skip')
            .map((c) => c.id),
        []
    )
})

test('a missing channel-default profile names the profiles that exist', () => {
    const dev = profile({
        name: 'dev',
        dirExists: false,
        config: { state: 'missing' },
        apiUrl: null,
        api: null,
        auth: null,
        units: null
    })
    const others = ['staging', 'accept'].map((name) =>
        profile({ name, current: false })
    )
    const checks = run(dev, {
        all: [dev, ...others],
        ctx: { currentProfile: 'dev' }
    })
    const config = find(checks, 'profile.config')
    assert.equal(config.status, 'warn')
    assert.match(config.detail, /this machine has staging, accept$/)
    assert.match(config.fix ?? '', /export MF_PROFILE=<name>/)
    assert.equal(
        checks.some((c) => c.status === 'fail'),
        false
    )
})

test('a profile chosen explicitly, or none at all, fails when it is missing', () => {
    const missing = profile({
        name: 'team-a',
        dirExists: false,
        config: { state: 'missing' },
        apiUrl: null,
        api: null,
        auth: null
    })
    const chosen = find(
        run(missing, {
            all: [missing, profile({ name: 'staging', current: false })],
            ctx: { currentProfile: 'team-a', profileSource: 'flag' }
        }),
        'profile.config'
    )
    assert.equal(chosen.status, 'fail')
    assert.match(chosen.detail, /selected by --profile/)
    assert.match(chosen.fix ?? '', /staging/)

    const fresh = find(run({ ...missing, name: 'default' }), 'profile.config')
    assert.equal(fresh.status, 'fail')
    assert.equal(fresh.fix, 'mf setup')
})

test('a daemon-only profile needs no sign-in; a corrupt config fails with its path', () => {
    const daemonOnly = registered({ config: { state: 'missing' } })
    const checks = run(daemonOnly)
    assert.equal(find(checks, 'profile.config').status, 'pass')
    assert.equal(find(checks, 'profile.auth').status, 'skip')

    const corrupt = find(
        run(
            profile({
                config: {
                    state: 'invalid',
                    message: 'invalid JSON in /cfg/profiles/default/config.json'
                }
            })
        ),
        'profile.config'
    )
    assert.equal(corrupt.status, 'fail')
    assert.match(
        corrupt.fix ?? '',
        /fix or delete \/cfg\/profiles\/default\/config\.json/
    )
})

test('a daemon on an older binary than the one on disk asks for a restart', () => {
    const skewed = registered({
        name: 'accept',
        current: false,
        health: localHealth({ version: '4.1.0', activeExecs: 2 })
    })
    const version = find(run(skewed), 'daemon.version')
    assert.equal(version.status, 'warn')
    assert.match(version.detail, /runs 4\.1\.0 but .+ is now 4\.2\.0/)
    assert.equal(
        version.fix,
        'mf --profile accept daemon stop && mf --profile accept daemon start (this ends 2 running sessions)'
    )

    const system = find(
        run(
            registered({
                health: localHealth({
                    version: '4.1.0',
                    startupMethod: 'launchd-system'
                })
            })
        ),
        'daemon.version'
    )
    assert.equal(
        system.fix,
        'sudo mf daemon stop --system && sudo mf daemon start --system'
    )

    const pending = find(
        run(
            registered({
                health: localHealth({
                    version: '4.1.0',
                    updatePending: true,
                    activeExecs: 1
                })
            })
        ),
        'daemon.version'
    )
    assert.match(pending.detail, /update is pending/)
    assert.equal(pending.fix, undefined)
})

test('the autostart unit and the process are judged together', () => {
    const crashLoop = find(
        run(
            registered({
                health: null,
                pid: null,
                units: {
                    user: { ...LIVE_UNIT, active: false },
                    system: unit('system')
                }
            })
        ),
        'daemon.process'
    )
    assert.equal(crashLoop.status, 'fail')
    assert.match(crashLoop.fix ?? '', /daemon\.err\.log/)

    const orphanUnit = find(
        run(
            profile({
                units: {
                    user: { ...LIVE_UNIT, active: false },
                    system: unit('system')
                }
            })
        ),
        'daemon.process'
    )
    assert.equal(orphanUnit.status, 'fail')
    assert.match(orphanUnit.detail, /no daemon registration/)

    const stopped = find(
        run(
            registered({
                health: null,
                pid: null,
                units: { user: unit('user'), system: unit('system') }
            })
        ),
        'daemon.process'
    )
    assert.equal(stopped.status, 'warn')
    assert.equal(stopped.fix, 'mf daemon start')

    const wedged = find(
        run(registered({ health: null, pid: 4242 })),
        'daemon.process'
    )
    assert.equal(wedged.status, 'warn')
    assert.match(wedged.detail, /does not answer/)
})

test('a unit pointing at a missing or different binary is reported', () => {
    const gone = find(
        run(
            registered({
                units: {
                    user: {
                        ...LIVE_UNIT,
                        invocation: ['/usr/local/bin/mf'],
                        programExists: false,
                        programRealpath: '/usr/local/bin/mf'
                    },
                    system: unit('system')
                }
            })
        ),
        'daemon.autostart'
    )
    assert.equal(gone.status, 'fail')
    assert.match(gone.detail, /\/usr\/local\/bin\/mf, which no longer exists/)

    const elsewhere = find(
        run(
            registered({
                units: {
                    user: {
                        ...LIVE_UNIT,
                        invocation: ['/usr/local/bin/mf'],
                        programRealpath: '/usr/local/bin/mf'
                    },
                    system: unit('system')
                }
            })
        ),
        'daemon.autostart'
    )
    assert.equal(elsewhere.status, 'warn')
    assert.match(elsewhere.detail, /updating one does not update the other/)

    const both = find(
        run(
            registered({
                units: {
                    user: LIVE_UNIT,
                    system: { ...LIVE_UNIT, scope: 'system' }
                }
            })
        ),
        'daemon.autostart'
    )
    assert.equal(both.status, 'warn')
    assert.match(both.detail, /both a user and a system unit/)

    const manual = find(
        run(
            registered({
                units: { user: unit('user'), system: unit('system') },
                health: localHealth({ startupMethod: 'manual' })
            })
        ),
        'daemon.autostart'
    )
    assert.equal(manual.status, 'warn')
    assert.match(manual.detail, /without an autostart unit/)
})

test('each rejected sign-in gets its own fix', () => {
    const rejected = (serverMessage: string) =>
        find(
            run(
                profile({
                    auth: {
                        kind: 'error',
                        status: 401,
                        code: 'unauthorized',
                        serverMessage
                    }
                })
            ),
            'profile.auth'
        )
    const expired = rejected('api token expired')
    assert.equal(expired.status, 'fail')
    assert.equal(expired.fix, 'mf login')
    assert.match(
        rejected('api token not found').fix ?? '',
        /mf login --api-url https:\/\/api\.test\/api/
    )
    assert.match(
        rejected('Missing bearer token').detail,
        /strips the Authorization header/
    )
    assert.match(rejected('account deactivated').detail, /deactivated/)
})

test('an API URL that is not an API says where the API is', () => {
    const html = find(
        run(
            profile({
                config: {
                    state: 'ok',
                    value: { apiUrl: 'https://mf.example.com', token: 't' }
                },
                apiUrl: 'https://mf.example.com',
                api: { kind: 'not-json', status: 200 },
                apiSuggestion: 'https://mf.example.com/api'
            })
        ),
        'profile.api'
    )
    assert.equal(html.status, 'fail')
    assert.equal(html.fix, 'mf login --api-url https://mf.example.com/api')

    const dbDown = find(
        run(
            profile({
                api: {
                    kind: 'ok',
                    status: 200,
                    body: { status: 'ok', db: 'down', version: '0.0.1' }
                }
            })
        ),
        'profile.api'
    )
    assert.equal(dbDown.status, 'fail')
    assert.match(dbDown.detail, /database is down/)

    const sso = find(
        run(
            profile({
                api: {
                    kind: 'redirect',
                    status: 302,
                    location: 'https://sso.example.com/login'
                }
            })
        ),
        'profile.api'
    )
    assert.match(sso.detail, /redirects to sso\.example\.com/)

    const refused = find(
        run(profile({ api: { kind: 'network', code: 'network_refused' } })),
        'profile.api'
    )
    assert.equal(refused.status, 'fail')
    assert.match(refused.detail, /connection was refused/)
    assert.equal(
        find(
            run(profile({ api: { kind: 'network', code: 'network_refused' } })),
            'profile.auth'
        ).status,
        'skip'
    )
})

test('an offline daemon is explained by its last disconnect', () => {
    const offline = (overrides: Partial<ProfileFacts>) =>
        find(
            run(
                registered({
                    health: localHealth({ wsConnected: false }),
                    daemonMe: hostSummary({
                        online: false,
                        lastSeenAt: '2026-09-23T11:00:00Z'
                    }),
                    ...overrides
                })
            ),
            'daemon.connection'
        )
    const header = offline({
        logCause: { kind: 'close', code: 4400, connectFailed: false }
    })
    assert.equal(header.status, 'fail')
    assert.match(header.detail, /strips the Authorization header/)

    const proxy = offline({
        logCause: { kind: 'unexpected-response', status: 400 }
    })
    assert.match(proxy.detail, /answered with HTTP 400/)
    assert.match(proxy.fix ?? '', /https:\/\/api\.test\/api\/daemon\/ws/)

    const restarting = offline({
        logCause: { kind: 'close', code: 1012, connectFailed: false }
    })
    assert.equal(restarting.status, 'warn')

    const tooOld = offline({
        logCause: { kind: 'close', code: 4406, connectFailed: false }
    })
    assert.match(tooOld.fix ?? '', /^mf update, then /)

    const heartbeatsOnly = offline({
        daemonMe: hostSummary({
            online: false,
            lastSeenAt: '2026-09-23T11:59:30Z'
        })
    })
    assert.match(heartbeatsOnly.detail, /heartbeats reach the API/)

    const lagging = find(
        run(registered({ daemonMe: hostSummary({ online: false }) })),
        'daemon.connection'
    )
    assert.equal(lagging.status, 'warn')
})

test('a dead registration fails whether or not the daemon runs', () => {
    const revoked = find(
        run(registered({ daemonMe: hostSummary({ status: 'revoked' }) })),
        'daemon.connection'
    )
    assert.equal(revoked.status, 'fail')
    assert.match(revoked.fix ?? '', /daemon register --token -/)

    const tokenGone = find(
        run(
            registered({
                health: null,
                pid: null,
                daemonMe: {
                    kind: 'error',
                    status: 401,
                    code: 'unauthorized',
                    serverMessage: 'token revoked'
                }
            })
        ),
        'daemon.connection'
    )
    assert.equal(tokenGone.status, 'fail')
    assert.match(tokenGone.detail, /revoked/)

    const needsUpgrade = find(
        run(registered({ daemonMe: hostSummary({ needsUpgrade: true }) })),
        'daemon.connection'
    )
    assert.match(needsUpgrade.fix ?? '', /^mf update, then /)

    const preProfile = find(
        run(
            registered({
                registration: {
                    state: 'ok',
                    value: {
                        apiUrl: 'https://api.test/api',
                        token: 'ldt_daemon',
                        daemonId: 'dh_1',
                        daemonUuid: 'uuid-1'
                    }
                }
            })
        ),
        'daemon.registration'
    )
    assert.equal(preProfile.status, 'fail')
    assert.equal(
        preProfile.detail,
        'the registration is incomplete: it has no profile, channel'
    )
})

test('a registration serving another deployment than the sign-in is flagged', () => {
    const slash = find(
        run(
            registered({
                config: {
                    state: 'ok',
                    value: { apiUrl: 'https://api.test/api/', token: 't' }
                }
            })
        ),
        'daemon.registration'
    )
    assert.equal(slash.status, 'pass')

    const moved = find(
        run(
            registered({
                config: {
                    state: 'ok',
                    value: { apiUrl: 'https://api.other/api', token: 't' }
                }
            })
        ),
        'daemon.registration'
    )
    assert.equal(moved.status, 'warn')
    assert.match(
        moved.detail,
        /serves https:\/\/api\.test\/api but this profile signs in to https:\/\/api\.other\/api/
    )
})

test('a profile nobody uses cannot fail the run', () => {
    const dormant = (name: string) =>
        run(
            profile({
                name,
                current: false,
                api: { kind: 'network', code: 'network_refused' }
            })
        )
    const api = find(dormant('old'), 'profile.api')
    assert.equal(api.status, 'warn')
    assert.match(
        api.fix ?? '',
        /or, if you no longer use this profile: mf profile delete old --yes$/
    )
    assert.match(
        find(dormant('default'), 'profile.api').fix ?? '',
        /mf profile delete default --yes --force$/
    )

    const inUse = find(
        run(
            registered({
                name: 'staging',
                current: false,
                api: { kind: 'network', code: 'network_refused' }
            })
        ),
        'profile.api'
    )
    assert.equal(inUse.status, 'fail')
})

test('profile files readable by others or owned by someone else are flagged', () => {
    const loose = find(
        run(
            profile({
                permissionIssues: [
                    {
                        path: '/cfg/profiles/default',
                        kind: 'mode',
                        mode: 0o755,
                        expected: 0o700
                    },
                    {
                        path: '/cfg/profiles/default/config.json',
                        kind: 'mode',
                        mode: 0o644,
                        expected: 0o600
                    },
                    {
                        path: '/cfg/profiles/default/config.json',
                        kind: 'owner',
                        uid: 0
                    }
                ]
            })
        ),
        'profile.permissions'
    )
    assert.equal(loose.status, 'warn')
    assert.match(loose.detail, /is 0755 \(want 0700\)/)
    assert.equal(
        loose.fix,
        'chmod 700 /cfg/profiles/default && chmod 600 /cfg/profiles/default/config.json && sudo chown -R "$(id -un)" /cfg/profiles/default'
    )
    assert.equal(
        find(
            run(profile(), { ctx: { platform: 'win32' } }),
            'profile.permissions'
        ).status,
        'skip'
    )
})

test('a coding agent on the PATH that the daemon did not detect is reported', () => {
    const frameworks = find(
        run(registered(), {
            machine: machine({
                frameworks: [
                    {
                        framework: 'claude-code',
                        path: '/opt/homebrew/bin/claude'
                    },
                    { framework: 'codex', path: '/Users/test/.volta/bin/codex' }
                ]
            })
        }),
        'daemon.frameworks'
    )
    assert.equal(frameworks.status, 'warn')
    assert.match(frameworks.detail, /^codex is on your PATH/)
    assert.match(frameworks.detail, /\/Users\/test\/\.volta\/bin/)
})

test('machine checks: updates and PATH', () => {
    const checks = (overrides: Partial<MachineFacts>) =>
        machineChecks(machine(overrides), context())
    const update = find(
        checks({
            update: {
                kind: 'checked',
                channel: 'stable',
                current: '4.2.0',
                latest: '4.3.0',
                status: 'update'
            }
        }),
        'cli.update'
    )
    assert.equal(update.status, 'warn')
    assert.equal(update.fix, 'mf update')
    assert.equal(
        find(
            checks({ update: { kind: 'error', message: 'timed out' } }),
            'cli.update'
        ).status,
        'warn'
    )

    const shadowed = find(
        checks({
            mfOnPath: [
                { path: '/usr/local/bin/mf', realpath: '/usr/local/bin/mf' },
                { path: MF, realpath: MF }
            ]
        }),
        'cli.path'
    )
    assert.equal(shadowed.status, 'warn')
    assert.match(
        shadowed.detail,
        /mf on your PATH is \/usr\/local\/bin\/mf, not this binary/
    )
    assert.match(
        find(
            checks({
                mfOnPath: [
                    { path: MF, realpath: MF },
                    { path: '/usr/local/bin/mf', realpath: '/usr/local/bin/mf' }
                ]
            }),
            'cli.path'
        ).detail,
        /could shadow this one: \/usr\/local\/bin\/mf/
    )
    assert.equal(find(checks({ mfOnPath: [] }), 'cli.path').status, 'warn')
    assert.equal(find(checks({ self: null }), 'cli.path').status, 'skip')

})

test('machine checks: overrides in this shell', () => {
    const overrides = (value: MachineFacts['overrides']) =>
        find(
            machineChecks(machine({ overrides: value }), context()),
            'config.overrides'
        )
    const staleEnvToken = overrides({
        apiUrl: null,
        token: { source: 'MF_TOKEN', fromStdin: false },
        stdinUnavailable: false,
        targetUrl: 'https://api.test/api',
        probe: {
            kind: 'error',
            status: 401,
            code: 'unauthorized',
            serverMessage: 'api token expired'
        }
    })
    assert.equal(staleEnvToken.status, 'fail')
    assert.match(staleEnvToken.fix ?? '', /^unset MF_TOKEN/)

    const runtime = overrides({
        apiUrl: null,
        token: { source: 'MF_API_TOKEN', fromStdin: false },
        stdinUnavailable: false,
        targetUrl: 'https://api.test/api',
        probe: {
            kind: 'ok',
            status: 200,
            body: { kind: 'agent-runtime', userId: 'usr_1', agentId: 'agt_1' }
        }
    })
    assert.equal(runtime.status, 'pass')
    assert.match(runtime.detail, /as agent agt_1$/)

    const badUrl = overrides({
        apiUrl: { value: 'https://example.com', source: 'MF_API_URL' },
        token: null,
        stdinUnavailable: false,
        targetUrl: 'https://example.com',
        probe: { kind: 'not-json', status: 200 }
    })
    assert.equal(badUrl.status, 'fail')
    assert.match(badUrl.fix ?? '', /^unset MF_API_URL/)

    assert.equal(
        overrides({
            apiUrl: null,
            token: { source: 'flag', fromStdin: true },
            stdinUnavailable: true,
            targetUrl: null,
            probe: null
        }).status,
        'skip'
    )
})

test('machine checks: terminal, coding agents, session hooks', () => {
    const checks = (overrides: Partial<MachineFacts>, ctx = context()) =>
        machineChecks(machine(overrides), ctx)
    const limited = find(
        checks({
            terminal: {
                problem:
                    'this mf binary predates built-in terminal support.\n  run `mf update` to get a binary with the built-in pty backend.\n  reason: x'
            }
        }),
        'local.terminal'
    )
    assert.equal(limited.status, 'warn')
    assert.match(limited.fix ?? '', /^run `mf update`/)
    assert.equal(
        find(checks({}, context({ platform: 'win32' })), 'local.terminal')
            .status,
        'skip'
    )

    assert.equal(
        find(checks({ frameworks: [] }), 'local.frameworks').status,
        'warn'
    )
    assert.equal(
        find(
            checks({ frameworks: [] }, context({ anyRegistration: false })),
            'local.frameworks'
        ).status,
        'skip'
    )

    const hooks = find(
        checks({
            hooks: [
                {
                    framework: 'claude-code',
                    current: true,
                    missingTarget: '/old/bin/mf',
                    note: null
                },
                {
                    framework: 'codex',
                    current: true,
                    missingTarget: null,
                    note: 'hooks are turned off in [features] of config.toml'
                }
            ]
        }),
        'local.hooks'
    )
    assert.equal(hooks.status, 'warn')
    assert.match(hooks.detail, /calls \/old\/bin\/mf, which no longer exists/)
    assert.match(hooks.fix ?? '', /mf daemon hooks install/)
    assert.match(hooks.fix ?? '', /config\.toml/)
    assert.equal(find(checks({ hooks: [] }), 'local.hooks').status, 'skip')
})

test('a local deployment that is down is one finding with a way out', () => {
    const local = registered({
        name: 'accept',
        current: false,
        config: {
            state: 'ok',
            value: { apiUrl: 'http://127.0.0.1:12222/api', token: 't' }
        },
        registration: {
            state: 'ok',
            value: {
                apiUrl: 'http://127.0.0.1:12222/api',
                token: 'ldt_daemon',
                daemonId: 'dh_1',
                daemonUuid: 'uuid-1',
                profile: 'accept',
                channel: 'stable'
            }
        },
        apiUrl: 'http://127.0.0.1:12222/api',
        api: { kind: 'network', code: 'network_refused' },
        daemonMe: { kind: 'network', code: 'network_refused' }
    })
    const checks = run(local)
    const api = find(checks, 'profile.api')
    assert.equal(api.status, 'fail')
    assert.equal(
        api.detail,
        'nothing is listening at http://127.0.0.1:12222/api'
    )
    assert.match(
        api.fix ?? '',
        /mf --profile accept daemon stop && mf profile delete accept --yes$/
    )
    const connection = find(checks, 'daemon.connection')
    assert.equal(connection.status, 'skip')
    assert.match(connection.detail, /see API/)
})
