import { frameworkRepoCloneUrl } from '@manyfold/shared'
import type { FrameworkDefaultVersionsSettings } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { FrameworkVersionsService } from '../src/modules/framework-versions/framework-versions.service'
import { buildNarraNexusRebuildShell } from '../src/modules/agents/bootstrap/narranexus-sprite'
import { AgentOrchestratorService } from '../src/modules/agents/orchestration/agent-orchestrator.service'

// NarraNexus is published to two repositories whose tag sets differ, so "which
// repo" is not cosmetic: it decides which versions exist. The catalog and the
// clone must resolve it from one place, because nothing downstream can catch a
// disagreement — the same tag name exists in both repos at different commits,
// so neither `git describe` nor the post-upgrade semver comparison can tell
// which repository a sprite was actually built from.

const UPSTREAM = 'NetMindAI-Open/NarraNexus'
const FORK = 'protagolabs/NarraNexus'

// v1.7.18 is fork-only; v1.15.0 is on both.
const FORK_ONLY = 'v1.7.18'

const storedFrom = (
    repo: string,
    versions: string[],
    prereleases: string[] = []
) => ({
    narranexus: {
        latest: versions[0],
        versions,
        prereleases,
        source: 'github' as const,
        repo,
        fetchedAt: new Date().toISOString()
    }
})

const dbWith = (frameworks: unknown) => {
    const db = {
        written: null as Record<string, unknown> | null,
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [{ valueJson: { frameworks } }]
                })
            })
        }),
        insert: () => ({
            values: (row: { valueJson: Record<string, unknown> }) => ({
                onConflictDoUpdate: async () => {
                    db.written = row.valueJson
                }
            })
        })
    }
    return db
}

const settingsBox = (initial: unknown) => {
    const box = {
        value: initial,
        getCachedFrameworkDefaultVersions: async () => {
            if (box.value instanceof Error) throw box.value
            return box.value as FrameworkDefaultVersionsSettings
        }
    }
    return box
}

const baseSettings = (
    sourceRepos: Record<string, string> = {},
    allowPrerelease: Record<string, boolean> = {}
) => ({
    defaults: {},
    minVersions: {},
    allowDowngrade: {},
    blockedVersions: {},
    sourceRepos,
    allowPrerelease
})

const serviceWith = (
    settings: ReturnType<typeof settingsBox> = settingsBox(baseSettings()),
    frameworks: unknown = storedFrom(UPSTREAM, ['v1.15.0', 'v1.7.15'])
) => {
    const db = dbWith(frameworks)
    return {
        settings,
        db,
        service: new FrameworkVersionsService(
            db as never,
            { get: () => undefined } as never,
            settings as never
        )
    }
}

test('an unconfigured platform resolves to the default repository', async () => {
    const { service } = serviceWith()

    assert.equal(await service.repoFor('narranexus'), UPSTREAM)
    assert.equal(
        (await service.getForFramework('narranexus')).sourceRepo,
        UPSTREAM
    )
})

test('repoFor is null for an npm-installed framework', async () => {
    const { service } = serviceWith()

    assert.equal(await service.repoFor('codex'), null)
})

// The one assertion that can catch a half-wired implementation: the versions on
// offer and the repository cloned have to move together.
test('the offered versions and the cloned repository never disagree', async () => {
    const box = settingsBox(baseSettings({ narranexus: FORK }))
    const { service } = serviceWith(
        box,
        storedFrom(FORK, ['v1.15.0', FORK_ONLY, 'v1.7.15'])
    )

    const onFork = await service.getForFramework('narranexus')
    assert.ok(onFork.versions.includes(FORK_ONLY))
    assert.equal(onFork.sourceRepo, FORK)

    const forkShell = buildNarraNexusRebuildShell(
        FORK_ONLY,
        (await service.repoFor('narranexus'))!
    )
    assert.ok(forkShell.includes(frameworkRepoCloneUrl(FORK)))
    assert.equal(forkShell.match(/github\.com/g)?.length, 1)

    // flip the source back: the catalog must stop offering the fork-only tag in
    // the same breath as the clone stops pointing at the fork
    box.value = baseSettings({ narranexus: UPSTREAM })

    const backOnUpstream = await service.getForFramework('narranexus')
    assert.deepEqual(backOnUpstream.versions, [])
    assert.equal(backOnUpstream.latest, null)
    assert.equal(backOnUpstream.sourceRepo, UPSTREAM)

    const upstreamShell = buildNarraNexusRebuildShell(
        'v1.15.0',
        (await service.repoFor('narranexus'))!
    )
    assert.ok(upstreamShell.includes(frameworkRepoCloneUrl(UPSTREAM)))
    assert.ok(!upstreamShell.includes(FORK))
})

// fetchedAt going null is what makes latestForFresh() re-fetch instead of
// trusting the previous repository's newest tag.
test('a stored entry from another repository reads as never fetched', async () => {
    const { service } = serviceWith(
        settingsBox(baseSettings({ narranexus: FORK })),
        storedFrom(UPSTREAM, ['v1.15.0', 'v1.7.15'])
    )

    const entry = await service.getForFramework('narranexus')

    assert.deepEqual(entry.versions, [])
    assert.equal(entry.latest, null)
    assert.equal(entry.fetchedAt, null)
    assert.equal(entry.sourceRepo, FORK)
})

// Rows written before the source became configurable carry no repo. They came
// from the default, so they must keep working without a refresh.
test('a legacy entry with no recorded repository counts as the default', async () => {
    const { service } = serviceWith(settingsBox(baseSettings()), {
        narranexus: {
            latest: 'v1.15.0',
            versions: ['v1.15.0', 'v1.7.15'],
            source: 'github' as const,
            fetchedAt: new Date().toISOString()
        }
    })

    const entry = await service.getForFramework('narranexus')

    assert.deepEqual(entry.versions, ['v1.15.0', 'v1.7.15'])
    assert.equal(entry.sourceRepo, UPSTREAM)
})

// Mirrors the denylist's "no deploy needed" guarantee: the check runs per read,
// so it cannot be stranded behind the 6h catalog cache.
test('switching the source takes effect without waiting out the catalog cache', async () => {
    const box = settingsBox(baseSettings())
    const { service } = serviceWith(
        box,
        storedFrom(UPSTREAM, ['v1.15.0', 'v1.7.15'])
    )

    assert.equal((await service.getCached()).length > 0, true)
    assert.deepEqual((await service.getForFramework('narranexus')).versions, [
        'v1.15.0',
        'v1.7.15'
    ])

    box.value = baseSettings({ narranexus: FORK })

    assert.deepEqual((await service.getForFramework('narranexus')).versions, [])
})

test('unreadable settings still resolve to the default repository', async () => {
    const { service } = serviceWith(settingsBox(new Error('relation missing')))

    assert.equal(await service.repoFor('narranexus'), UPSTREAM)
})

test('refreshFramework fetches the resolved repository and records it', async () => {
    const { service, db } = serviceWith(
        settingsBox(baseSettings({ narranexus: FORK })),
        storedFrom(UPSTREAM, ['v1.15.0'])
    )
    const seen: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
        seen.push(String(url))
        return new Response(JSON.stringify([{ name: FORK_ONLY }]), {
            status: 200
        })
    }) as typeof fetch

    try {
        await service.refreshFramework('narranexus')
    } finally {
        globalThis.fetch = originalFetch
    }

    assert.equal(seen.length, 1)
    assert.ok(
        seen[0].startsWith(
            `https://api.github.com/repos/${FORK}/tags?per_page=`
        ),
        seen[0]
    )
    // recording the repo alongside the tags is what lets a later read notice
    // the stored list came from somewhere the platform no longer points at
    const written = db.written as {
        frameworks: { narranexus: { repo: string; versions: string[] } }
    }
    assert.equal(written.frameworks.narranexus.repo, FORK)
    assert.deepEqual(written.frameworks.narranexus.versions, [FORK_ONLY])
})

// An admin default pin reaches the clone as a raw string, so this guard is the
// one thing between it and the sprite's shell. Unquoted, that `;` would end the
// git command and run the rest.
//
// Admitting semver prereleases must not widen this: a valid semver string is
// drawn from `[0-9A-Za-z.+-]`, so every case below still fails the guard — this
// test is deliberately unchanged from before the opt-in.
test('both clone builders refuse a version that could reach the shell', () => {
    for (const bad of [
        '1.2.3-;rm -rf /tmp/pwned',
        '1.2.3+$(id)',
        '1.2.3 && id',
        'main'
    ])
        assert.throws(
            () => buildNarraNexusRebuildShell(bad, UPSTREAM),
            /invalid narranexus version/,
            bad
        )
})

// The tag this whole feature exists for. `1.15.1-rc.1` is fork-only and, being
// hyphenated, was dropped by the catalog and refused by the clone guard.
test('the clone builder accepts a semver prerelease tag', () => {
    for (const good of ['1.15.1-rc.1', 'v1.15.1-rc.1', 'v1.7.13-oss'])
        assert.ok(
            buildNarraNexusRebuildShell(good, FORK).includes(
                `git clone --depth 1 --branch "${good}"`
            ),
            good
        )
})

test('the clone builder refuses a repository outside the allowlist shape', () => {
    assert.throws(
        () => buildNarraNexusRebuildShell('v1.15.0', 'foo/bar; rm -rf /'),
        /invalid framework repo slug/
    )
})

test('the clone command quotes the tag and the url', () => {
    const shell = buildNarraNexusRebuildShell('v1.15.0', UPSTREAM)

    assert.ok(
        shell.includes(
            `git clone --depth 1 --branch "v1.15.0" "${frameworkRepoCloneUrl(UPSTREAM)}"`
        ),
        shell
    )
})

// The install path's repo and version must come from ONE settings read. A
// second read could see a source switch land in between and hand the bootstrap
// a tag that only exists on the repository it is no longer cloning.
const orchestratorWith = (sourceRepos: Record<string, string>) => {
    const service = Object.create(
        AgentOrchestratorService.prototype
    ) as AgentOrchestratorService
    let reads = 0
    Object.assign(service, {
        adminSettings: {
            getCachedFrameworkDefaultVersions: async () => {
                reads += 1
                return { ...baseSettings(sourceRepos) }
            }
        },
        frameworkVersions: { latestForFresh: async () => 'v1.15.0' }
    })
    return {
        reads: () => reads,
        resolve: (framework: string) =>
            (
                service as unknown as {
                    resolveFrameworkVersion: (
                        f: string,
                        r?: string | null
                    ) => Promise<{
                        selection: { version: string | null; source: string }
                        repo: string | null
                    }>
                }
            ).resolveFrameworkVersion(framework)
    }
}

test('a create resolves version and repository from one settings read', async () => {
    const { resolve, reads } = orchestratorWith({ narranexus: FORK })

    const resolved = await resolve('narranexus')

    assert.equal(resolved.repo, FORK)
    assert.equal(resolved.selection.version, 'v1.15.0')
    assert.equal(reads(), 1)
})

test('a create for an npm framework resolves no repository', async () => {
    const { resolve } = orchestratorWith({})

    assert.equal((await resolve('codex')).repo, null)
})

// Prereleases are stored apart from `versions` and merged in at read time, so
// flipping the opt-in takes effect on the next read rather than after a
// re-fetch — the same property the source switch and the denylist rely on.
test('the prerelease opt-in withholds and admits at read time', async () => {
    // stored from the fork, and pointed at it: 1.15.1-rc.1 is fork-only, so any
    // other pairing would be emptied by the source check instead
    const box = settingsBox(baseSettings({ narranexus: FORK }))
    const { service } = serviceWith(
        box,
        storedFrom(FORK, ['v1.15.0', 'v1.7.15'], ['1.15.1-rc.1'])
    )

    const off = await service.getForFramework('narranexus')
    assert.deepEqual(off.versions, ['v1.15.0', 'v1.7.15'])
    assert.equal(off.latest, 'v1.15.0')

    box.value = baseSettings({ narranexus: FORK }, { narranexus: true })

    const on = await service.getForFramework('narranexus')
    // merged by precedence: the rc of an unreleased 1.15.1 outranks v1.15.0
    assert.deepEqual(on.versions, ['1.15.1-rc.1', 'v1.15.0', 'v1.7.15'])
    // ...but `latest` stays the newest STABLE release, because it is the tier a
    // fresh agent installs and the target the upgrade nag points at
    assert.equal(on.latest, 'v1.15.0')
})

// Rows written before the opt-in existed have no prerelease list at all. They
// must keep reading cleanly, which is also why the admin form re-fetches the
// catalog when the toggle changes.
test('a catalog row predating the opt-in reads as having no prereleases', async () => {
    const { service } = serviceWith(
        settingsBox(baseSettings({}, { narranexus: true })),
        {
            narranexus: {
                latest: 'v1.15.0',
                versions: ['v1.15.0', 'v1.7.15'],
                source: 'github' as const,
                repo: UPSTREAM,
                fetchedAt: new Date().toISOString()
            }
        }
    )

    const entry = await service.getForFramework('narranexus')

    assert.deepEqual(entry.versions, ['v1.15.0', 'v1.7.15'])
    assert.equal(entry.latest, 'v1.15.0')
})

// A prerelease is never the implicit install target, so `latest` has to be the
// newest stable at WRITE time too — not a property applied by readers.
test('a fetch partitions tags and keeps latest stable', async () => {
    const { service, db } = serviceWith(
        settingsBox(baseSettings({ narranexus: FORK })),
        storedFrom(FORK, [])
    )
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
        new Response(
            JSON.stringify([
                { name: 'v1.15.0' },
                { name: '1.15.1-rc.1' },
                { name: 'v0.1.0-alpha.1' },
                { name: 'v1.7.15' },
                // neither installable nor comparable: three core components are
                // required at every install site
                { name: 'v1.7' },
                { name: 'nightly' }
            ]),
            { status: 200 }
        )) as typeof fetch

    try {
        await service.refreshFramework('narranexus')
    } finally {
        globalThis.fetch = originalFetch
    }

    const written = db.written as {
        frameworks: {
            narranexus: {
                latest: string
                versions: string[]
                prereleases: string[]
            }
        }
    }
    assert.deepEqual(written.frameworks.narranexus.versions, [
        'v1.15.0',
        'v1.7.15'
    ])
    assert.deepEqual(written.frameworks.narranexus.prereleases, [
        '1.15.1-rc.1',
        'v0.1.0-alpha.1'
    ])
    assert.equal(written.frameworks.narranexus.latest, 'v1.15.0')
})

// Switching the source repository has to empty the prerelease list with the
// rest: `1.15.1-rc.1` is fork-only, and offering it after a switch to upstream
// would be the exact picker/clone split the source resolver exists to prevent.
test('a source switch drops the previous repository prereleases too', async () => {
    const { service } = serviceWith(
        settingsBox(
            baseSettings({ narranexus: UPSTREAM }, { narranexus: true })
        ),
        storedFrom(FORK, ['v1.15.0'], ['1.15.1-rc.1'])
    )

    const entry = await service.getForFramework('narranexus')

    assert.deepEqual(entry.versions, [])
    assert.equal(entry.latest, null)
    assert.equal(entry.fetchedAt, null)
})

// withPolicy hands out the DTO, not its internal working copy: leaking the
// prerelease list would make it a de facto part of the HTTP contract.
test('the served entry carries no internal prerelease field', async () => {
    const { service } = serviceWith(
        settingsBox(baseSettings()),
        storedFrom(FORK, ['v1.15.0'], ['1.15.1-rc.1'])
    )

    const entry = await service.getForFramework('narranexus')

    assert.equal('prereleases' in entry, false)
})
