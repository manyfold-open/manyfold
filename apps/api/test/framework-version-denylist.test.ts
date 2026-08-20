import type { FrameworkDefaultVersionsSettings } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { FrameworkVersionsService } from '../src/modules/framework-versions/framework-versions.service'
import { FrameworkUpgradeService } from '../src/modules/agents/framework-versions/framework-upgrade.service'
import { AgentOrchestratorService } from '../src/modules/agents/orchestration/agent-orchestrator.service'
import {
    buildNpmLatestInstallShell,
    frameworkVersionDescriptor
} from '../src/modules/framework-versions/framework-version-registry'

// #594: npm's gemini-cli `latest` was 0.54.0 while 0.53.0-0.54.0 write
// tool-call history with no thought signature, so every later turn of that
// session gets a provider 400 forever. Every admission point — catalog listing,
// fresh install, in-place upgrade — has to refuse that window while leaving
// 0.52.0 and any patched release installable.

const STORED = {
    'gemini-cli': {
        latest: '0.54.0',
        versions: ['0.54.0', '0.53.1', '0.53.0', '0.52.0', '0.51.0'],
        source: 'npm' as const,
        fetchedAt: new Date().toISOString()
    },
    codex: {
        latest: '1.1.0',
        versions: ['1.1.0', '1.0.5', '1.0.0'],
        source: 'npm' as const,
        fetchedAt: new Date().toISOString()
    }
}

const dbWith = (frameworks: unknown) => ({
    select: () => ({
        from: () => ({
            where: () => ({
                limit: async () => [{ valueJson: { frameworks } }]
            })
        })
    })
})

// A live settings box: flipping it between reads is how the "no deploy needed"
// claim gets tested.
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

const serviceWith = (
    settings: ReturnType<typeof settingsBox> = settingsBox({
        defaults: {},
        minVersions: {},
        allowDowngrade: {},
        blockedVersions: {}
    }),
    frameworks: unknown = STORED
) => ({
    settings,
    service: new FrameworkVersionsService(
        dbWith(frameworks) as never,
        { get: () => undefined } as never,
        settings as never
    )
})

const geminiEntry = async (service: FrameworkVersionsService) =>
    service.getForFramework('gemini-cli')

test('the broken gemini window never appears in the catalog', async () => {
    const { service } = serviceWith()

    const entry = await geminiEntry(service)

    assert.deepEqual(entry.versions, ['0.52.0', '0.51.0'])
    // the incident in one assertion: npm's dist-tag pointed INTO the window, so
    // an unpinned create installed 0.54.0. Falling back to the newest surviving
    // release keeps "install latest" meaningful instead of returning null.
    assert.equal(entry.latest, '0.52.0')
    assert.equal(entry.blocked.length, 1)
    assert.equal(entry.blocked[0].min, '0.53.0')
})

// The other half of the contract: once upstream ships the fix, the catalog must
// behave exactly as it did before the denylist existed.
test('a patched release above the window is offered and becomes latest', async () => {
    const { service } = serviceWith(undefined, {
        'gemini-cli': {
            ...STORED['gemini-cli'],
            latest: '0.55.0',
            versions: ['0.55.0', '0.54.0', '0.53.0', '0.52.0']
        }
    })

    const entry = await geminiEntry(service)

    assert.equal(entry.latest, '0.55.0')
    assert.deepEqual(entry.versions, ['0.55.0', '0.52.0'])
})

test('a framework with no blocked window is left untouched', async () => {
    const { service } = serviceWith()

    const entry = await service.getForFramework('codex')

    assert.equal(entry.latest, '1.1.0')
    assert.deepEqual(entry.versions, ['1.1.0', '1.0.5', '1.0.0'])
    assert.deepEqual(entry.blocked, [])
})

// Containing an incident cannot mean waiting out the catalog's 6h TTL, so the
// cache holds the RAW upstream view and the denylist is applied per read.
test('an operator-added window takes effect on the next read, not after the cache expires', async () => {
    const { service, settings } = serviceWith()

    assert.deepEqual(
        (await service.getForFramework('codex')).versions,
        ['1.1.0', '1.0.5', '1.0.0'],
        'catalog is cached with codex intact'
    )

    settings.value = {
        defaults: {},
        minVersions: {},
        allowDowngrade: {},
        blockedVersions: {
            codex: [{ min: '1.0.0', max: '1.0.9', reason: 'operator window' }]
        }
    }

    const entry = await service.getForFramework('codex')
    assert.deepEqual(entry.versions, ['1.1.0'])
    assert.equal(entry.blocked[0].reason, 'operator window')
})

// A fresh database has no settings row and the read can fail outright; the
// compiled-in window is exactly what must survive that.
test('unreadable settings still leave the built-in window blocked', async () => {
    const { service } = serviceWith(settingsBox(new Error('relation missing')))

    const entry = await geminiEntry(service)

    assert.deepEqual(entry.versions, ['0.52.0', '0.51.0'])
    assert.equal(entry.latest, '0.52.0')
})

// The one install with no catalog to filter (registry unreachable AND the
// sprite image ships no binary): the exclusion has to ride inside the npm spec.
test('the blind latest install cannot resolve into the broken window', () => {
    const shell = buildNpmLatestInstallShell(
        frameworkVersionDescriptor('gemini-cli')
    )

    assert.match(shell, /'@google\/gemini-cli@<0\.53\.0 \|\| >0\.54\.0'/)
    // the spec carries spaces, `<`, `>` and `||` — unquoted, the shell would
    // read `||` as a command separator and install whatever `latest` is
    assert.doesNotMatch(shell, /npm install [^\n]*[^']@google\/gemini-cli@</)
    assert.match(shell, /\[ -n "\$got" \]/)
    assert.ok(shell.indexOf('--version') < shell.indexOf('mv -Tf'))
})

test('a framework with no blocked window still installs the plain latest tag', () => {
    const shell = buildNpmLatestInstallShell(
        frameworkVersionDescriptor('codex')
    )

    assert.match(shell, /'@openai\/codex@latest'/)
})

const blockedCatalog = {
    framework: 'gemini-cli' as const,
    latest: '0.52.0',
    versions: ['0.52.0', '0.51.0'],
    source: 'npm' as const,
    fetchedAt: null,
    blocked: [
        {
            min: '0.53.0',
            max: '0.54.0',
            reason: 'unsigned tool-call history'
        }
    ]
}

// loadRuntime's db read is the last thing between the policy checks and a real
// sprite call, so the fake reports whichever CLI the test says is installed.
const runtimeDb = (frameworkVersion: string) => ({
    select: () => ({
        from: () => ({
            where: () => ({
                limit: async () => [
                    {
                        id: 'rt_1',
                        kind: 'sprites',
                        spriteName: 'sprite-1',
                        accountId: 'sac_1',
                        frameworkVersion
                    }
                ]
            })
        })
    })
})

const upgradeWith = (opts: {
    installedVersion: string
    allowDowngrade?: boolean
    catalog?: typeof blockedCatalog
}) =>
    new FrameworkUpgradeService(
        runtimeDb(opts.installedVersion) as never,
        {
            // reaching the sprite means every policy check passed — a
            // distinctive failure marks that boundary without a live sprite
            getById: async () => {
                throw new Error('sprite boundary reached')
            }
        } as never,
        {
            findForCaller: async () => ({
                id: 'agt_1',
                framework: 'gemini-cli',
                runtimeId: 'rt_1',
                spriteName: 'sprite-1',
                accountId: 'sac_1'
            })
        } as never,
        {
            getForFramework: async () => opts.catalog ?? blockedCatalog
        } as never,
        {} as never,
        {
            getCachedFrameworkDefaultVersions: async () => ({
                defaults: {},
                minVersions: {},
                allowDowngrade: { 'gemini-cli': opts.allowDowngrade ?? true },
                blockedVersions: {}
            })
        } as never
    )

// Without this the caller is told the version "is not in the catalog" — true,
// but it reads as a catalog bug and says nothing about what to install instead.
test('an upgrade to a blocked version is refused with the reason, not a catalog miss', async () => {
    await assert.rejects(
        () =>
            upgradeWith({ installedVersion: '0.52.0' }).upgrade(
                'agt_1',
                'usr_1',
                '0.53.1',
                false
            ),
        (err: Error) => {
            assert.match(err.message, /unsigned tool-call history/)
            assert.doesNotMatch(err.message, /not in the .* catalog/)
            return true
        }
    )
})

// An admin is not an escape hatch here: installing the broken release on
// purpose just reproduces the incident.
test('not even an admin may upgrade into the blocked window', async () => {
    await assert.rejects(
        () =>
            upgradeWith({ installedVersion: '0.52.0' }).upgrade(
                'agt_1',
                'usr_1',
                '0.54.0',
                true
            ),
        /is blocked/
    )
})

// The escape route out of the incident IS a downgrade (0.53.1 -> 0.52.0).
// Enforcing the no-downgrade gate there would pin a user to a CLI that 400s on
// every turn, so the gate yields when what's installed is itself blocked.
test('a user on a blocked version may downgrade out of it despite the downgrade gate', async () => {
    await assert.rejects(
        () =>
            upgradeWith({
                installedVersion: '0.53.1',
                allowDowngrade: false
            }).upgrade('agt_1', 'usr_1', '0.52.0', false),
        /sprite boundary reached/
    )
})

test('the downgrade gate still applies from a healthy version', async () => {
    await assert.rejects(
        () =>
            upgradeWith({
                installedVersion: '0.52.0',
                allowDowngrade: false
            }).upgrade('agt_1', 'usr_1', '0.51.0', false),
        /downgrading gemini-cli below the installed version/
    )
})
// The agent-create path is where the incident actually landed: an unpinned
// gemini agent installed whatever npm called latest. resolveFrameworkVersion
// owns that decision, and needs only two of the orchestrator's dependencies.
const resolveVersionWith = (opts: {
    adminDefault?: string
    catalogLatest: string | null
    blockedVersions?: Record<string, unknown>
}) => {
    const service = Object.create(
        AgentOrchestratorService.prototype
    ) as AgentOrchestratorService
    let latestFetched = false
    Object.assign(service, {
        adminSettings: {
            getCachedFrameworkDefaultVersions: async () => ({
                defaults: opts.adminDefault
                    ? { 'gemini-cli': opts.adminDefault }
                    : {},
                minVersions: {},
                allowDowngrade: {},
                blockedVersions: opts.blockedVersions ?? {}
            })
        },
        frameworkVersions: {
            latestForFresh: async () => {
                latestFetched = true
                return opts.catalogLatest
            }
        }
    })
    // resolveFrameworkVersion also returns the source repository it resolved in
    // the same settings read; these cases only assert version selection, so
    // unwrap it here rather than restating the wrapper in every assertion.
    const resolveFull = (requested?: string | null) =>
        (
            service as unknown as {
                resolveFrameworkVersion: (
                    framework: string,
                    requested?: string | null
                ) => Promise<{
                    selection: { version: string | null; source: string }
                    repo: string | null
                }>
            }
        ).resolveFrameworkVersion('gemini-cli', requested)
    const resolve = async (requested?: string | null) =>
        (await resolveFull(requested)).selection
    return { resolve, latestFetched: () => latestFetched }
}

// The catalog already withholds the window, so `latest` arrives clean; this
// pins that the create path installs it rather than falling through.
test('an unpinned create installs the newest surviving release', async () => {
    const { resolve } = resolveVersionWith({ catalogLatest: '0.52.0' })

    assert.deepEqual(await resolve(), { version: '0.52.0', source: 'latest' })
})

// A pin left behind from before the incident must not keep installing the
// broken CLI — and the catalog tier can only take over if it is consulted at
// all, which the pre-#594 code skipped whenever any pin existed.
test('a create whose admin pin is blocked falls through to the catalog', async () => {
    const { resolve, latestFetched } = resolveVersionWith({
        adminDefault: '0.53.1',
        catalogLatest: '0.52.0'
    })

    assert.deepEqual(await resolve(), { version: '0.52.0', source: 'latest' })
    assert.ok(latestFetched(), 'the catalog tier was consulted')
})

// Substituting a different version behind the caller's back would break
// per-agent reproduction; the create fails with something they can act on.
test('a create naming a blocked version is rejected with the reason', async () => {
    const { resolve } = resolveVersionWith({ catalogLatest: '0.52.0' })

    await assert.rejects(
        () => resolve('0.53.1'),
        (err: Error) => {
            assert.match(err.message, /gemini-cli 0\.53\.1 is blocked/)
            assert.match(err.message, /thought signature/)
            assert.match(err.message, /0\.52\.0 or a release carrying/)
            return true
        }
    )
})

test('an operator window blocks a create the built-in list would allow', async () => {
    const { resolve } = resolveVersionWith({
        catalogLatest: '0.52.0',
        blockedVersions: {
            'gemini-cli': [
                { min: '0.52.0', max: '0.52.9', reason: 'operator window' }
            ]
        }
    })

    await assert.rejects(() => resolve('0.52.5'), /operator window/)
})
