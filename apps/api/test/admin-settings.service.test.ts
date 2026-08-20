import assert from 'node:assert/strict'
import test from 'node:test'
import { appSettings, auditLogs } from '@manyfold/db'
import { AdminSettingsService } from '../src/modules/admin-settings/admin-settings.service'

class FakeDb {
    settings = new Map<string, Record<string, unknown>>()
    audits: Record<string, unknown>[] = []

    select(_shape?: unknown) {
        return new FakeQuery(this, 'select')
    }

    insert(table: unknown) {
        return new FakeQuery(this, 'insert', table)
    }
}

class FakeQuery {
    private table: unknown
    private value: Record<string, unknown> = {}
    private conflictUpdate: Record<string, unknown> | null = null

    constructor(
        private readonly db: FakeDb,
        private readonly op: 'select' | 'insert',
        table?: unknown
    ) {
        this.table = table
    }

    from(table: unknown) {
        this.table = table
        return this
    }

    where(_cond: unknown) {
        return this
    }

    limit(_n: number) {
        if (this.table !== appSettings) return Promise.resolve([])
        const row =
            this.db.settings.get('feature_toggles') ??
            (this.db.settings.size === 1
                ? [...this.db.settings.values()][0]
                : undefined)
        return Promise.resolve(row ? [{ valueJson: row }] : [])
    }

    values(value: Record<string, unknown>) {
        this.value = value
        if (this.table === auditLogs) {
            this.db.audits.push(value)
            return Promise.resolve()
        }
        return this
    }

    onConflictDoUpdate(input: { set: Record<string, unknown> }) {
        this.conflictUpdate = input.set
        return this
    }

    then<TResult1 = unknown, TResult2 = never>(
        onfulfilled?:
            | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
            | null,
        onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | null
    ): Promise<TResult1 | TResult2> {
        if (this.op === 'insert' && this.table === appSettings) {
            const key = this.value.key as string
            const valueJson = (this.conflictUpdate?.valueJson ??
                this.value.valueJson) as Record<string, unknown>
            this.db.settings.set(key, valueJson)
        }
        return Promise.resolve([]).then(onfulfilled, onrejected)
    }
}


const serviceWith = (db = new FakeDb()): AdminSettingsService =>
    new AdminSettingsService(db as never)

test('AdminSettingsService feature toggles fall back to the registry default (cloud_computer off)', async () => {
    const service = serviceWith()

    const view = await service.getFeatureToggles()
    const cloud = view.toggles.find((toggle) => toggle.key === 'cloud_computer')

    assert.ok(cloud)
    assert.equal(cloud.enabled, false)
    assert.equal(cloud.defaultEnabled, false)
    assert.equal(cloud.overridden, false)
    assert.equal(await service.isFeatureEnabled('cloud_computer'), false)
})

test('AdminSettingsService stores a feature toggle override that wins over the default', async () => {
    const db = new FakeDb()
    const service = serviceWith(db)

    const view = await service.updateFeatureToggle(
        'admin-1',
        'cloud_computer',
        true
    )
    const cloud = view.toggles.find((toggle) => toggle.key === 'cloud_computer')

    assert.ok(cloud)
    assert.equal(cloud.enabled, true)
    assert.equal(cloud.overridden, true)
    assert.equal(await service.isFeatureEnabled('cloud_computer'), true)
    assert.equal(db.audits.length, 1)
})

test('AdminSettingsService rejects unknown feature toggle keys', async () => {
    const service = serviceWith()

    await assert.rejects(
        () => service.updateFeatureToggle('admin-1', 'not_a_real_toggle', true),
        /unknown feature toggle/
    )
})

test('AdminSettingsService requires migrated framework runtime defaults', async () => {
    const service = serviceWith()

    await assert.rejects(
        () => service.getFrameworkRuntimeDefaults(),
        /framework runtime defaults setting is missing/
    )
})

test('AdminSettingsService stores complete framework runtime defaults', async () => {
    const db = new FakeDb()
    const service = serviceWith(db)

    const view = await service.updateFrameworkRuntimeDefaults('admin-1', {
        defaults: {
            hermes: 'sprites',
            openclaw: 'k8s'
        }
    })

    assert.deepEqual(view.defaults, {
        hermes: 'sprites',
        openclaw: 'k8s'
    })
    assert.deepEqual(db.settings.get('framework_runtime_defaults'), view)
})

test('AdminSettingsService rejects incomplete framework runtime defaults', async () => {
    const service = serviceWith()

    await assert.rejects(
        () =>
            service.updateFrameworkRuntimeDefaults('admin-1', {
                defaults: { hermes: 'sprites' }
            } as never),
        /framework 'openclaw' default is required/
    )
})

test('AdminSettingsService rejects defaults for non-configurable frameworks', async () => {
    const service = serviceWith()

    await assert.rejects(
        () =>
            service.updateFrameworkRuntimeDefaults('admin-1', {
                defaults: {
                    hermes: 'sprites',
                    openclaw: 'sprites',
                    codex: 'sprites'
                }
            } as never),
        /framework 'codex' default is not configurable/
    )
})

test('AdminSettingsService stores framework default versions with min + downgrade policy', async () => {
    const db = new FakeDb()
    const service = serviceWith(db)

    const view = await service.updateFrameworkDefaultVersions('admin-1', {
        defaults: { 'claude-code': '2.1.0' },
        minVersions: { 'claude-code': '2.0.0' },
        // true is the default — only the restrictive `false` is persisted
        allowDowngrade: { 'claude-code': false, codex: true }
    })

    assert.deepEqual(view, {
        defaults: { 'claude-code': '2.1.0' },
        minVersions: { 'claude-code': '2.0.0' },
        allowDowngrade: { 'claude-code': false },
        blockedVersions: {},
        sourceRepos: {},
        // false is the default (pre-releases withheld) — only the permissive
        // `true` is persisted, the mirror of allowDowngrade above
        allowPrerelease: {}
    })
    assert.deepEqual(db.settings.get('framework_default_versions'), view)
    assert.deepEqual(await service.getFrameworkDefaultVersions(), view)
})

test('AdminSettingsService rejects a pinned default below its minimum version', async () => {
    const service = serviceWith()

    await assert.rejects(
        () =>
            service.updateFrameworkDefaultVersions('admin-1', {
                defaults: { 'claude-code': '2.0.0' },
                minVersions: { 'claude-code': '2.1.0' }
            }),
        /below its minimum supported version/
    )
})

test('AdminSettingsService rejects a minimum version for a non-upgradeable framework', async () => {
    const service = serviceWith()

    await assert.rejects(
        () =>
            service.updateFrameworkDefaultVersions('admin-1', {
                defaults: {},
                minVersions: { dify: '1.0.0' }
            }),
        /framework 'dify' does not support a minimum version/
    )
})

test('AdminSettingsService automation retention defaults to 90 days when unset', async () => {
    const service = serviceWith()

    assert.deepEqual(await service.getAutomationRetention(), {
        retentionDays: 90
    })
})

test('AdminSettingsService stores automation retention, audits, and serves it back', async () => {
    const db = new FakeDb()
    const service = serviceWith(db)

    const saved = await service.updateAutomationRetention('admin-1', {
        retentionDays: 30
    })

    assert.deepEqual(saved, { retentionDays: 30 })
    assert.deepEqual(db.settings.get('automation_retention_days'), saved)
    assert.equal(db.audits.length, 1)
    assert.equal(
        db.audits[0].action,
        'admin.settings.automation_retention_days.update'
    )
    assert.equal(db.audits[0].subject, 'automation_retention_days')
    assert.deepEqual(await service.getAutomationRetention(), saved)
    assert.deepEqual(await service.getCachedAutomationRetention(), saved)
})

test('AdminSettingsService rejects non-positive or fractional automation retention', async () => {
    const service = serviceWith()

    for (const retentionDays of [0, -1, 1.5, Number.NaN, 4000]) {
        await assert.rejects(
            () =>
                service.updateAutomationRetention('admin-1', {
                    retentionDays
                }),
            /retentionDays must be an integer between 1 and 3650/
        )
    }
})

test('AdminSettingsService falls back to the default when the stored retention is corrupt', async () => {
    const db = new FakeDb()
    db.settings.set('automation_retention_days', { retentionDays: 'soon' })
    const service = serviceWith(db)

    assert.deepEqual(await service.getAutomationRetention(), {
        retentionDays: 90
    })
})

test('AdminSettingsService a2a turn timeouts default when unset, with a null override', async () => {
    const service = serviceWith()

    assert.deepEqual(await service.getA2aTurnTimeouts(), {
        blockingTimeoutSeconds: 600,
        asyncTimeoutSeconds: 7200
    })
    assert.equal(await service.getCachedA2aTurnTimeoutsOverride(), null)
})

test('AdminSettingsService stores a2a turn timeouts, audits, and serves the override', async () => {
    const db = new FakeDb()
    const service = serviceWith(db)

    const saved = await service.updateA2aTurnTimeouts('admin-1', {
        blockingTimeoutSeconds: 300,
        asyncTimeoutSeconds: 14_400
    })

    assert.deepEqual(saved, {
        blockingTimeoutSeconds: 300,
        asyncTimeoutSeconds: 14_400
    })
    assert.deepEqual(db.settings.get('a2a_turn_timeouts'), saved)
    assert.equal(db.audits.length, 1)
    assert.deepEqual(await service.getCachedA2aTurnTimeoutsOverride(), saved)
    assert.deepEqual(await service.getA2aTurnTimeouts(), saved)
})

test('AdminSettingsService rejects out-of-range a2a turn timeouts', async () => {
    const service = serviceWith()

    await assert.rejects(
        () =>
            service.updateA2aTurnTimeouts('admin-1', {
                blockingTimeoutSeconds: 10,
                asyncTimeoutSeconds: 7200
            }),
        /blockingTimeoutSeconds must be an integer between 30 and 3600/
    )
    await assert.rejects(
        () =>
            service.updateA2aTurnTimeouts('admin-1', {
                blockingTimeoutSeconds: 4000,
                asyncTimeoutSeconds: 7200
            }),
        /blockingTimeoutSeconds must be an integer between 30 and 3600/
    )
    await assert.rejects(
        () =>
            service.updateA2aTurnTimeouts('admin-1', {
                blockingTimeoutSeconds: 600,
                asyncTimeoutSeconds: 100_000
            }),
        /asyncTimeoutSeconds must be an integer between/
    )
    // async below blocking violates the cross-field rule
    await assert.rejects(
        () =>
            service.updateA2aTurnTimeouts('admin-1', {
                blockingTimeoutSeconds: 600,
                asyncTimeoutSeconds: 300
            }),
        /asyncTimeoutSeconds must be an integer between/
    )
    await assert.rejects(
        () =>
            service.updateA2aTurnTimeouts('admin-1', {
                blockingTimeoutSeconds: 600.5,
                asyncTimeoutSeconds: 7200
            }),
        /blockingTimeoutSeconds must be an integer/
    )
})

// #594: containing a broken upstream release must not require a deploy, so an
// operator can add a window here. The stored map is also what the catalog
// filter reads, which makes accidental loss of a window an outage risk.
const GEMINI_WINDOW = {
    'gemini-cli': [
        { min: '0.53.0', max: '0.54.0', reason: 'unsigned tool-call history' }
    ]
}

test('AdminSettingsService stores an operator-added blocked version window', async () => {
    const service = serviceWith()

    const saved = await service.updateFrameworkDefaultVersions('admin-1', {
        defaults: {},
        blockedVersions: GEMINI_WINDOW
    })

    assert.deepEqual(saved.blockedVersions, GEMINI_WINDOW)
    assert.deepEqual(
        (await service.getFrameworkDefaultVersions()).blockedVersions,
        GEMINI_WINDOW
    )
})

// The admin versions form PUTs defaults/minVersions/allowDowngrade and nothing
// else. Reading an omitted key as "clear it" would un-block a broken release
// the next time anyone saved an unrelated pin.
test('AdminSettingsService keeps blocked windows when the update omits them', async () => {
    const service = serviceWith()
    await service.updateFrameworkDefaultVersions('admin-1', {
        defaults: {},
        blockedVersions: GEMINI_WINDOW
    })

    const saved = await service.updateFrameworkDefaultVersions('admin-1', {
        defaults: { codex: '1.0.0' },
        minVersions: {},
        allowDowngrade: {}
    })

    assert.deepEqual(saved.blockedVersions, GEMINI_WINDOW)
    assert.equal(saved.defaults.codex, '1.0.0')
})

// Pinning a release the platform refuses to install would fail every create for
// that framework with a confusing "blocked" error at bootstrap time. Reject the
// pin at the point the operator can still fix it.
test('AdminSettingsService rejects a default pinned inside a blocked window', async () => {
    const service = serviceWith()

    await assert.rejects(
        () =>
            service.updateFrameworkDefaultVersions('admin-1', {
                defaults: { 'gemini-cli': '0.53.1' },
                blockedVersions: GEMINI_WINDOW
            }),
        /is blocked/
    )
    // and against the built-in window, with no operator config at all
    await assert.rejects(
        () =>
            service.updateFrameworkDefaultVersions('admin-1', {
                defaults: { 'gemini-cli': '0.54.0' }
            }),
        /is blocked/
    )
})

test('AdminSettingsService pins outside the window are still accepted', async () => {
    const service = serviceWith()

    const saved = await service.updateFrameworkDefaultVersions('admin-1', {
        defaults: { 'gemini-cli': '0.52.0' }
    })

    assert.equal(saved.defaults['gemini-cli'], '0.52.0')
})

// A malformed window is worse than none: it either blocks nothing or blocks
// everything, and nobody finds out until a create fails.
test('AdminSettingsService rejects malformed blocked version windows', async () => {
    const service = serviceWith()
    const rejects = (blockedVersions: unknown, pattern: RegExp) =>
        assert.rejects(
            () =>
                service.updateFrameworkDefaultVersions('admin-1', {
                    defaults: {},
                    blockedVersions: blockedVersions as never
                }),
            pattern
        )

    await rejects(
        { 'gemini-cli': [{ min: 'main', max: '0.54.0', reason: 'x' }] },
        /semver/
    )
    await rejects(
        { 'gemini-cli': [{ min: '0.54.0', max: '0.53.0', reason: 'x' }] },
        /inverted/
    )
    await rejects(
        { 'gemini-cli': [{ min: '0.53.0', max: '0.54.0', reason: '  ' }] },
        /needs a reason/
    )
    await rejects(
        { dify: [{ min: '0.53.0', max: '0.54.0', reason: 'x' }] },
        /does not support a blocked version range/
    )
    await rejects({ 'gemini-cli': 'everything' }, /must be an array/)
})

const FORK = 'protagolabs/NarraNexus'

test('AdminSettingsService stores an allowlisted version source repository', async () => {
    const service = serviceWith()

    const saved = await service.updateFrameworkDefaultVersions('admin-1', {
        defaults: {},
        sourceRepos: { narranexus: FORK }
    })

    assert.equal(saved.sourceRepos.narranexus, FORK)
    assert.equal(
        (await service.getFrameworkDefaultVersions()).sourceRepos.narranexus,
        FORK
    )
})

// A sprite builds and runs whatever it clones, so the repository is not free
// text — only a compiled-in candidate may be stored.
test('AdminSettingsService rejects a repository outside the allowlist', async () => {
    const service = serviceWith()

    await assert.rejects(
        service.updateFrameworkDefaultVersions('admin-1', {
            defaults: {},
            sourceRepos: { narranexus: 'attacker/NarraNexus' }
        }),
        /is not an allowed repository/
    )
})

test('AdminSettingsService rejects a version source on an npm framework', async () => {
    const service = serviceWith()

    await assert.rejects(
        service.updateFrameworkDefaultVersions('admin-1', {
            defaults: {},
            sourceRepos: { codex: FORK }
        }),
        /does not support a version source repository/
    )
})

// Same hazard as the blocked-window merge, plus one more: apps deploy
// independently, so an older Admin build can PUT mid-rollout and must not
// reset the operator's repository choice.
test('AdminSettingsService keeps the version source when the update omits it', async () => {
    const service = serviceWith()
    await service.updateFrameworkDefaultVersions('admin-1', {
        defaults: {},
        sourceRepos: { narranexus: FORK }
    })

    const saved = await service.updateFrameworkDefaultVersions('admin-1', {
        defaults: { codex: '1.0.0' },
        minVersions: {},
        allowDowngrade: {}
    })

    assert.equal(saved.sourceRepos.narranexus, FORK)
    assert.equal(saved.defaults.codex, '1.0.0')
})

// An explicit empty map is a clear, unlike an omitted one.
test('AdminSettingsService clears the version source on an explicit empty map', async () => {
    const service = serviceWith()
    await service.updateFrameworkDefaultVersions('admin-1', {
        defaults: {},
        sourceRepos: { narranexus: FORK }
    })

    const saved = await service.updateFrameworkDefaultVersions('admin-1', {
        defaults: {},
        sourceRepos: {}
    })

    assert.deepEqual(saved.sourceRepos, {})
})

// The admin pin is the one install route that never passes through the catalog,
// so withholding prereleases there says nothing about it. Refusing at config
// time is what stops a pin that would be silently skipped at every create.
test('AdminSettingsService refuses a pre-release pin while the opt-in is off', async () => {
    const service = serviceWith()

    await assert.rejects(
        () =>
            service.updateFrameworkDefaultVersions('admin-1', {
                defaults: { narranexus: '1.15.1-rc.1' }
            }),
        /pre-release/
    )
})

test('AdminSettingsService accepts a pre-release pin once the framework opts in', async () => {
    const service = serviceWith()

    const saved = await service.updateFrameworkDefaultVersions('admin-1', {
        defaults: { narranexus: '1.15.1-rc.1' },
        allowPrerelease: { narranexus: true }
    })

    assert.equal(saved.defaults.narranexus, '1.15.1-rc.1')
    assert.equal(saved.allowPrerelease.narranexus, true)
})

// Apps deploy independently, so an Admin build predating this field can PUT
// mid-rollout. Treating the omission as "off" would close a channel an operator
// is mid-verification on, and take their pin down with it.
test('AdminSettingsService keeps a stored pre-release opt-in when the field is omitted', async () => {
    const service = serviceWith()
    await service.updateFrameworkDefaultVersions('admin-1', {
        defaults: {},
        allowPrerelease: { narranexus: true }
    })

    const saved = await service.updateFrameworkDefaultVersions('admin-1', {
        defaults: { narranexus: '1.15.1-rc.1' }
    })

    assert.equal(saved.allowPrerelease.narranexus, true)
    assert.equal(saved.defaults.narranexus, '1.15.1-rc.1')
})

// The floor is a policy statement, and semver says an rc precedes its release.
// Under the core-only comparison this used to use, `1.15.1-rc.1` read as EQUAL
// to a `1.15.1` floor and slipped through.
test('AdminSettingsService reads a pre-release as below its own release floor', async () => {
    const service = serviceWith()

    await assert.rejects(
        () =>
            service.updateFrameworkDefaultVersions('admin-1', {
                defaults: { narranexus: '1.15.1-rc.1' },
                minVersions: { narranexus: '1.15.1' },
                allowPrerelease: { narranexus: true }
            }),
        /below its minimum supported version/
    )
})

test('AdminSettingsService rejects a pre-release opt-in for a framework with no installable CLI', async () => {
    const service = serviceWith()

    await assert.rejects(
        () =>
            service.updateFrameworkDefaultVersions('admin-1', {
                defaults: {},
                allowPrerelease: { dify: true } as never
            }),
        /does not support pre-release versions/
    )
})
