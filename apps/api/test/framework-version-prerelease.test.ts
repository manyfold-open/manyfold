import type { FrameworkDefaultVersionsSettings } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { FrameworkUpgradeService } from '../src/modules/agents/framework-versions/framework-upgrade.service'

// The upgrade endpoint is the third admission point for the pre-release opt-in.
// The catalog already withholds pre-releases when it is off, so the version
// would fail the `∈ catalog` check anyway — but "not in the catalog" reads as a
// catalog bug and says nothing about which switch to flip. Same argument as the
// denylist's own ordering (see framework-version-denylist.test.ts).

const CATALOG_OFF = {
    framework: 'narranexus' as const,
    latest: 'v1.15.0',
    versions: ['v1.15.0', 'v1.7.15'],
    source: 'github' as const,
    sourceRepo: 'protagolabs/NarraNexus',
    fetchedAt: new Date().toISOString(),
    blocked: []
}

const CATALOG_ON = {
    ...CATALOG_OFF,
    versions: ['1.15.1-rc.1', 'v1.15.0', 'v1.7.15']
}

const settings = (
    overrides: Partial<FrameworkDefaultVersionsSettings> = {}
): FrameworkDefaultVersionsSettings => ({
    defaults: {},
    minVersions: {},
    allowDowngrade: {},
    blockedVersions: {},
    sourceRepos: {},
    allowPrerelease: {},
    ...overrides
})

const runtimeDb = (installedVersion: string) => ({
    select: () => ({
        from: () => ({
            where: () => ({
                limit: async () => [
                    {
                        id: 'rt_1',
                        kind: 'sprites',
                        spriteName: 'sprite-1',
                        accountId: 'sac_1',
                        frameworkVersion: installedVersion,
                        dashboardEnabled: false
                    }
                ]
            })
        })
    })
})

const upgradeWith = (opts: {
    installedVersion?: string
    allowPrerelease?: boolean
    minVersion?: string
    catalog?: typeof CATALOG_OFF
}) =>
    new FrameworkUpgradeService(
        runtimeDb(opts.installedVersion ?? 'v1.15.0') as never,
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
                framework: 'narranexus',
                runtimeId: 'rt_1',
                spriteName: 'sprite-1',
                accountId: 'sac_1'
            })
        } as never,
        {
            getForFramework: async () =>
                opts.catalog ??
                (opts.allowPrerelease ? CATALOG_ON : CATALOG_OFF),
            repoFor: async () => 'protagolabs/NarraNexus'
        } as never,
        {} as never,
        {
            getCachedFrameworkDefaultVersions: async () =>
                settings({
                    allowPrerelease: opts.allowPrerelease
                        ? { narranexus: true }
                        : {},
                    minVersions: opts.minVersion
                        ? { narranexus: opts.minVersion }
                        : {}
                })
        } as never
    )

const upgradeTo = (
    service: FrameworkUpgradeService,
    version: string
): Promise<unknown> =>
    service.upgradeStreaming('agt_1', 'usr_1', version, false, {
        step: () => undefined
    })

test('a pre-release upgrade names the switch to flip, not a catalog miss', async () => {
    await assert.rejects(
        () => upgradeTo(upgradeWith({}), '1.15.1-rc.1'),
        (err: Error) => {
            assert.match(err.message, /pre-release/)
            assert.doesNotMatch(err.message, /not in the .* catalog/)
            return true
        }
    )
})

test('the same upgrade reaches the sprite once the framework opts in', async () => {
    await assert.rejects(
        () => upgradeTo(upgradeWith({ allowPrerelease: true }), '1.15.1-rc.1'),
        /sprite boundary reached/
    )
})

// Semver puts an rc below its own release, so a `1.15.1` floor has to exclude
// `1.15.1-rc.1`. The core-only comparison this replaced read them as equal and
// let the rc through.
test('a pre-release is below a floor set at its own release', async () => {
    await assert.rejects(
        () =>
            upgradeTo(
                upgradeWith({ allowPrerelease: true, minVersion: '1.15.1' }),
                '1.15.1-rc.1'
            ),
        /below the minimum supported version/
    )
    // ...and a floor below it still admits it
    await assert.rejects(
        () =>
            upgradeTo(
                upgradeWith({ allowPrerelease: true, minVersion: '1.15.0' }),
                '1.15.1-rc.1'
            ),
        /sprite boundary reached/
    )
})

// The opt-in gates pre-releases, not every upgrade: a stable target must behave
// exactly as it did before the feature existed.
test('a stable upgrade is unaffected by the opt-in being off', async () => {
    await assert.rejects(
        () => upgradeTo(upgradeWith({}), 'v1.7.15'),
        /sprite boundary reached/
    )
})
