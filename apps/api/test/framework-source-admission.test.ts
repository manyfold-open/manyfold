import assert from 'node:assert/strict'
import { once } from 'node:events'
import test, { type TestContext } from 'node:test'
import {
    FIXTURE,
    FIXTURE_HOME,
    FIXTURE_FORK,
    FIXTURE_UPSTREAM,
    FixtureSpriteBootstrap,
    fixtureVersion
} from './helpers/fixture-framework'
import { extensionsWith } from './helpers/framework-extensions-stub'
import { BadRequestException, HttpException } from '@nestjs/common'
import type {
    FrameworkDefaultVersionsSettings,
    FrameworkVersionCatalogEntry
} from '@manyfold/shared'
import { WebSocketServer } from 'ws'
import { AgentOrchestratorService } from '../src/modules/agents/orchestration/agent-orchestrator.service'
import { FrameworkUpgradeService } from '../src/modules/agents/framework-versions/framework-upgrade.service'
import { FrameworkVersionsService } from '../src/modules/framework-versions/framework-versions.service'
import { HermesSpriteBootstrap } from '../src/modules/agents/bootstrap/hermes-sprite'
import { SpritesProvisioner } from '../src/modules/agent-runtimes/provisioning/sprites-provisioner'
import {
    BootstrapError,
    type BootstrapContext
} from '../src/modules/agents/bootstrap/framework-bootstrap'
import type { SpriteServiceBootstrap } from '../src/modules/agents/bootstrap/sprite-framework-bootstrap'
import { SandboxesService } from '../src/modules/sandboxes/sandboxes.service'

const UPSTREAM = FIXTURE_UPSTREAM
const FORK = FIXTURE_FORK
const SHARED = 'v9.1.0'
const FORK_ONLY = 'v9.2.0'
const boundary = new BadRequestException('fixture provisioning boundary')

const settingsFor = (
    repo: string,
    pin?: string
): FrameworkDefaultVersionsSettings => ({
    defaults: pin ? { [FIXTURE]: pin } : {},
    minVersions: {},
    allowDowngrade: {},
    blockedVersions: {},
    sourceRepos: { [FIXTURE]: repo },
    allowPrerelease: {}
})

const catalogFor = (
    repo: string,
    versions = [SHARED]
): FrameworkVersionCatalogEntry => ({
    framework: FIXTURE,
    latest: versions[0] ?? null,
    versions,
    source: 'github',
    sourceRepo: repo,
    fetchedAt: new Date().toISOString(),
    blocked: []
})

const fixture = (repo = UPSTREAM, pin?: string) => {
    const box = { settings: settingsFor(repo, pin), catalog: catalogFor(repo) }
    const admin = {
        getCachedFrameworkDefaultVersions: async () => box.settings
    }
    const versions = new FrameworkVersionsService(
        {} as never,
        {} as never,
        admin as never
    )
    versions.getForFramework = async () => box.catalog
    return { box, admin, versions }
}

const cachedFixture = () => {
    const f = fixture()
    f.box.catalog.fetchedAt = '2000-01-01T00:00:00.000Z'
    let stored: unknown = {
        [FIXTURE]: { ...f.box.catalog, repo: UPSTREAM }
    }
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [{ valueJson: { frameworks: stored } }]
                })
            })
        }),
        insert: () => ({
            values: (row: { valueJson: { frameworks: unknown } }) => ({
                onConflictDoUpdate: async () => {
                    stored = row.valueJson.frameworks
                }
            })
        })
    }
    f.versions = new FrameworkVersionsService(
        db as never,
        { get: () => undefined } as never,
        f.admin as never
    )
    return f
}

const barrier = () => {
    let open!: () => void
    const reached = new Promise<void>((resolve) => {
        open = resolve
    })
    return { reached, open }
}

const peer = async (t: TestContext) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    t.after(async () => {
        for (const socket of server.clients) socket.terminate()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const shells: string[] = []
    const stopped: string[] = []
    const started: string[] = []
    let nextExitCode = 0
    let failAll = false
    server.on('connection', (socket, request) => {
        const cmd = new URL(request.url!, 'http://fixture').searchParams.getAll(
            'cmd'
        )
        shells.push(cmd[2])
        socket.send(Buffer.from([0x03, failAll ? 1 : nextExitCode]))
        nextExitCode = 0
    })
    const client = {
        wsBaseUrl: `ws://127.0.0.1:${address.port}`,
        authHeaderForInternalUse: () => ({}),
        stopService: async (_sprite: string, name: string) => {
            stopped.push(name)
        },
        startService: async (_sprite: string, name: string) => {
            started.push(name)
            return { state: { status: 'running' } }
        },
        upsertService: async () => {},
        updateSprite: async () => {},
        getSprite: async () => ({ url: null })
    }
    return {
        client,
        shells,
        stopped,
        started,
        failNext: () => {
            nextExitCode = 1
        },
        failAll: () => {
            failAll = true
        }
    }
}

const consumer = async (
    t: TestContext,
    kind: 'create' | 'prepare',
    f: ReturnType<typeof fixture>
) => {
    const sprite = await peer(t)
    const calls: Record<string, unknown>[] = []
    const bootstrap = new FixtureSpriteBootstrap()
    const provision = async (args: Record<string, unknown>) => {
        calls.push(args)
        await bootstrap.run(
            {
                ...args,
                agentId: 'agt_fixture',
                runtimeId: 'art_fixture',
                userId: 'usr_fixture',
                spriteName: 'fixture',
                mountPath: '/fixture',
                client: sprite.client,
                logger: {
                    info: () => {},
                    debug: () => {},
                    warn: () => {},
                    error: () => {}
                }
            } as never,
            {}
        )
        throw boundary
    }
    if (kind === 'create') {
        const service = Object.create(AgentOrchestratorService.prototype)
        Object.assign(service, {
            db: {
                select: () => ({
                    from: () => ({ where: () => ({ limit: async () => [] }) })
                })
            },
            credentialsResolver: {
                resolve: async () => ({ framework: FIXTURE, value: {} })
            },
            adminSettings: f.admin,
            frameworkVersions: f.versions,
            spritesProvisioner: { provisionRuntime: provision },
            extensions: extensionsWith()
        })
        return {
            ...sprite,
            calls,
            run: (requested?: string) =>
                service.createSprites(
                    {
                        userId: 'usr_fixture',
                        actorUserId: 'usr_fixture',
                        isAdmin: false,
                        dto: {
                            framework: FIXTURE,
                            name: 'fixture',
                            frameworkVersion: requested
                        }
                    },
                    { step: () => {} }
                ) as Promise<unknown>
        }
    }
    const service = Object.create(SandboxesService.prototype)
    Object.assign(service, {
        runtimes: {
            listRunnerHosts: async () => [],
            getSandboxForUser: async () => ({
                host: {
                    id: 'sbx_fixture',
                    userId: 'usr_fixture',
                    spriteId: 'sprite',
                    spriteName: 'fixture',
                    accountId: 'spa_fixture'
                }
            }),
            listRuntimesByHost: async () => []
        },
        crypto: {},
        frameworkVersions: f.versions,
        spritesProvisioner: { prepareRuntime: provision }
    })
    return {
        ...sprite,
        calls,
        run: () =>
            service.prepareRuntime(
                'usr_fixture',
                'sbx_fixture',
                FIXTURE
            ) as Promise<unknown>
    }
}

for (const kind of ['create', 'prepare'] as const) {
    test(
        `${kind} refuses a source-switched admin pin before provisioning`,
        { timeout: 10_000 },
        async (t) => {
            const f = fixture(FORK, FORK_ONLY)
            f.box.settings = settingsFor(UPSTREAM, FORK_ONLY)
            f.box.catalog = catalogFor(UPSTREAM)
            const h = await consumer(t, kind, f)
            await assert.rejects(h.run(), (error: unknown) => {
                assert.ok(error instanceof HttpException)
                assert.equal(error.getStatus(), 400)
                assert.match(error.message, /admin.*pin|pin.*admin/i)
                assert.match(error.message, /fixture-gateway/)
                return true
            })
            assert.equal(h.calls.length, 0)
            assert.equal(h.shells.length, 0)
        }
    )

    test(
        `${kind} carries the catalog repository through a deferred latest read into the install shell`,
        { timeout: 10_000 },
        async (t) => {
            const f = fixture()
            const entered = barrier()
            const release = barrier()
            t.after(() => release.open())
            f.versions.getForFramework = async () => {
                entered.open()
                await release.reached
                return f.box.catalog
            }
            const h = await consumer(t, kind, f)
            const running = assert.rejects(
                h.run(),
                (error: unknown) => error === boundary
            )
            try {
                await entered.reached
                f.box.settings = settingsFor(FORK)
                f.box.catalog = catalogFor(FORK, [FORK_ONLY])
            } finally {
                release.open()
            }
            await running
            assert.equal(h.calls[0].frameworkVersion, FORK_ONLY)
            assert.equal(h.calls[0].frameworkRepo, FORK)
            assert.equal(h.shells.length, 1)
            assert.ok(h.shells[0].includes(`https://github.com/${FORK}.git`))
            assert.ok(h.shells[0].includes(`--branch "${FORK_ONLY}"`))
            assert.ok(!h.shells[0].includes(UPSTREAM))
        }
    )
}

test(
    'an explicit git version must belong to the catalog before create enters provisioning',
    { timeout: 10_000 },
    async (t) => {
        const h = await consumer(t, 'create', fixture())
        await assert.rejects(h.run(FORK_ONLY), /not in.*catalog/i)
        assert.equal(h.calls.length, 0)
    }
)

for (const tier of ['explicit', 'admin', 'latest'] as const) {
    test(
        `the ${tier} tier admits a version and its repository together`,
        { timeout: 10_000 },
        async (t) => {
            const f = fixture(FORK, tier === 'admin' ? SHARED : undefined)
            const h = await consumer(t, 'create', f)
            await assert.rejects(
                h.run(tier === 'explicit' ? SHARED : undefined),
                (error: unknown) => error === boundary
            )
            assert.equal(h.calls[0].frameworkVersionSource, tier)
            assert.equal(h.calls[0].frameworkRepo, FORK)
            assert.ok(h.shells[0].includes(`https://github.com/${FORK}.git`))
        }
    )
}

const upgrade = async (t: TestContext, entry = catalogFor(FORK)) => {
    const sprite = await peer(t)
    const f = fixture(FORK)
    f.box.catalog = entry
    let repoReads = 0
    f.versions.repoFor = async () => {
        repoReads++
        return f.box.settings.sourceRepos[FIXTURE]!
    }
    const runtime = {
        id: 'art_fixture',
        kind: 'sprites',
        spriteName: 'fixture',
        accountId: 'spa_fixture',
        frameworkVersion: 'v9.0.0'
    }
    const service = new FrameworkUpgradeService(
        {
            select: () => ({
                from: () => ({
                    where: () => ({ limit: async () => [runtime] })
                })
            }),
            transaction: async (work: (tx: unknown) => Promise<unknown>) =>
                work({ execute: async () => [{ acquired: true }] })
        } as never,
        {} as never,
        {
            findForCaller: async () => ({
                id: 'agt_fixture',
                framework: FIXTURE,
                runtimeId: runtime.id
            }),
            get: async () => ({ id: 'agt_fixture' })
        } as never,
        f.versions,
        { probeAndPersist: async () => SHARED } as never,
        f.admin as never,
        extensionsWith({
            framework: FIXTURE,
            version: fixtureVersion,
            // A rebuild on a sandbox reads the framework's home from here.
            spriteService: { supervision: { homeDir: FIXTURE_HOME } } as never
        }) as never
    )
    Object.assign(service, { spriteClientFor: async () => sprite.client })
    return {
        ...sprite,
        f,
        service,
        repoReads: () => repoReads,
        run: (version = SHARED) =>
            service.upgradeStreaming(
                'agt_fixture',
                'usr_fixture',
                version,
                false,
                { step: () => {} }
            )
    }
}

test(
    'upgrade keeps the admitted repository when settings switch before the rebuild shell',
    { timeout: 10_000 },
    async (t) => {
        const h = await upgrade(t)
        const entered = barrier()
        const release = barrier()
        t.after(() => release.open())
        Object.assign(h.service, {
            spriteClientFor: async () => {
                entered.open()
                await release.reached
                return h.client
            }
        })
        const running = h.run()
        try {
            await entered.reached
            h.f.box.settings = settingsFor(UPSTREAM)
        } finally {
            release.open()
        }
        await running
        const fixtureCommits: Record<string, string> = {
            [UPSTREAM]: 'upstream-commit',
            [FORK]: 'fork-commit'
        }
        const selectedRepo = Object.keys(fixtureCommits).find((repo) =>
            h.shells[0].includes(`https://github.com/${repo}.git`)
        )
        assert.equal(fixtureCommits[selectedRepo!], 'fork-commit')
        assert.equal(h.repoReads(), 0)
        assert.equal(h.stopped.length, 1)
    }
)

test(
    'a stale source catalog refuses an upgrade before stopping the service',
    { timeout: 10_000 },
    async (t) => {
        const h = await upgrade(t, catalogFor(UPSTREAM, []))
        await assert.rejects(h.run(), /not in.*catalog/i)
        assert.equal(h.stopped.length, 0)
        assert.equal(h.shells.length, 0)
    }
)

test(
    'an admitted rebuild failure still restores the previous checkout and restarts it',
    { timeout: 10_000 },
    async (t) => {
        const h = await upgrade(t)
        h.failNext()
        await assert.rejects(h.run(), /rebuild failed/)
        assert.equal(h.shells.length, 2)
        assert.match(h.shells[1], /mv "[^"]+\/app\.bak" "[^"]+\/app"/)
        assert.equal(h.stopped.length, 1)
        assert.equal(h.started.length, 1)
    }
)

test(
    'same-source cached admission survives an upstream refresh failure',
    { timeout: 10_000 },
    async (t) => {
        const f = cachedFixture()
        f.versions.refreshFramework = async () => {
            throw new Error('fixture upstream unavailable')
        }
        const h = await consumer(t, 'create', f)
        await assert.rejects(h.run(), (error: unknown) => error === boundary)
        assert.equal(h.calls[0].frameworkVersion, SHARED)
        assert.equal(h.calls[0].frameworkRepo, UPSTREAM)
        assert.ok(h.shells[0].includes(`https://github.com/${UPSTREAM}.git`))
    }
)

for (const refresh of ['rejects', 'succeeds'] as const) {
    test(
        `a source switch while refresh ${refresh} cannot reuse the old repository snapshot`,
        { timeout: 10_000 },
        async (t) => {
            const f = cachedFixture()
            const entered = barrier()
            const release = barrier()
            t.after(() => release.open())
            t.mock.method(globalThis, 'fetch', async () => {
                entered.open()
                await release.reached
                if (refresh === 'rejects')
                    throw new Error('fixture upstream unavailable')
                return new Response(JSON.stringify([{ name: SHARED }]), {
                    status: 200
                })
            })
            const h = await consumer(t, 'prepare', f)
            const running = assert.rejects(h.run(), (error: unknown) => {
                assert.ok(error instanceof HttpException)
                assert.equal(error.getStatus(), 503)
                return true
            })
            try {
                await entered.reached
                f.box.settings = settingsFor(FORK)
            } finally {
                release.open()
            }
            await running
            assert.equal(h.calls.length, 0)
            assert.equal(h.shells.length, 0)
            const entry = await f.versions.getForFramework(FIXTURE)
            assert.equal(entry.sourceRepo, FORK)
            assert.deepEqual(entry.versions, [])
        }
    )
}

test(
    'a successful fresh catalog that has no versions cannot fall back to a cached tag',
    { timeout: 10_000 },
    async (t) => {
        const f = cachedFixture()
        t.mock.method(
            globalThis,
            'fetch',
            async () => new Response('[]', { status: 200 })
        )
        const h = await consumer(t, 'create', f)
        await assert.rejects(
            h.run(),
            (error: unknown) =>
                error instanceof HttpException && error.getStatus() === 503
        )
        assert.equal(h.calls.length, 0)
        assert.equal(h.shells.length, 0)
    }
)

test('an available Hermes semver tag is admitted from its single repository', async () => {
    const f = fixture()
    f.versions.getForFramework = async () => ({
        ...catalogFor('NousResearch/hermes-agent', ['v2026.9.14']),
        framework: 'hermes'
    })
    const result = await f.versions.resolveInstallVersion('hermes')
    assert.equal(result.selection.version, 'v2026.9.14')
    assert.equal(result.repo, 'NousResearch/hermes-agent')
})

for (const tier of ['explicit', 'admin', 'latest'] as const) {
    test(`an unavailable catalog is a 503 for the ${tier} tier, not proof of a missing tag`, async () => {
        const f = fixture(UPSTREAM, tier === 'admin' ? SHARED : undefined)
        f.box.catalog = { ...catalogFor(UPSTREAM, []), fetchedAt: null }
        f.versions.refreshFramework = async () => f.box.catalog
        await assert.rejects(
            f.versions.resolveInstallVersion(
                FIXTURE,
                tier === 'explicit' ? SHARED : undefined
            ),
            (error: unknown) =>
                error instanceof HttpException && error.getStatus() === 503
        )
    })
}

for (const framework of [FIXTURE, 'hermes'] as const) {
    test(
        `git latest ${framework} installation never retries an unadmitted default`,
        { timeout: 10_000 },
        async (t) => {
            const h = await peer(t)
            h.failAll()
            const bootstrap: SpriteServiceBootstrap =
                framework === FIXTURE
                    ? new FixtureSpriteBootstrap()
                    : new HermesSpriteBootstrap({} as never)
            const run = bootstrap.run.bind(bootstrap)
            let originalError: unknown
            const versions: Array<string | null | undefined> = []
            t.mock.method(
                bootstrap,
                'run',
                async (ctx: BootstrapContext, credentials: unknown) => {
                    versions.push(ctx.frameworkVersion)
                    try {
                        return await run(ctx, credentials)
                    } catch (error) {
                        originalError ??= error
                        throw error
                    }
                }
            )
            const provisioner = Object.create(SpritesProvisioner.prototype)
            const repo =
                framework === FIXTURE ? FORK : 'NousResearch/hermes-agent'
            await assert.rejects(
                provisioner.runServiceBootstrap(
                    bootstrap,
                    {
                        agentId: 'agt_fixture',
                        runtimeId: 'art_fixture',
                        userId: 'usr_fixture',
                        spriteName: 'fixture',
                        mountPath: '/fixture',
                        client: h.client,
                        logger: {
                            info: () => {},
                            debug: () => {},
                            warn: () => {},
                            error: () => {}
                        },
                        frameworkVersion: SHARED,
                        frameworkVersionSource: 'latest',
                        frameworkRepo: repo
                    },
                    {}
                ),
                (error: unknown) =>
                    error instanceof BootstrapError && error === originalError
            )
            assert.deepEqual(versions, [SHARED])
            assert.equal(h.shells.length, 1)
            assert.ok(h.shells[0].includes(SHARED))
            assert.ok(
                h.shells[0].includes(
                    framework === 'hermes'
                        ? `https://raw.githubusercontent.com/${repo}/${SHARED}/scripts/install.sh`
                        : `https://github.com/${repo}.git`
                )
            )
        }
    )
}
