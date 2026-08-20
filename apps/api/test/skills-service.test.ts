import type { DiscoverableSkillSummary } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import { agents, skillRepos, skills, userSkills } from '@manyfold/db'
import { SkillsService } from '../src/modules/skills/skills.service'
import type { SkillOutcome } from '../src/modules/skills/skill-materializer.service'

const now = new Date('2026-04-25T12:00:00.000Z')

const discovered: DiscoverableSkillSummary = {
    skillId: 'github:anthropics/skills@main:skills/pdf',
    name: 'PDF Toolkit',
    description: 'Work with PDF files',
    repoOwner: 'anthropics',
    repoName: 'skills',
    repoBranch: 'main',
    sourcePath: 'skills/pdf',
    latestRevision: 'rev-2',
    version: null,
    readmeUrl: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
    installDir: 'pdf-toolkit',
    installed: false,
    enabled: false,
    userSkillId: null,
    repoId: 'builtin:anthropics/skills@main',
    repoReadonly: true,
    category: null,
    tags: [],
    featured: false,
    updatedAt: now.toISOString(),
    installCount: 0
}

const skillRow = {
    id: discovered.skillId,
    name: discovered.name,
    description: discovered.description,
    repoOwner: discovered.repoOwner,
    repoName: discovered.repoName,
    repoBranch: discovered.repoBranch,
    sourcePath: discovered.sourcePath,
    latestRevision: discovered.latestRevision,
    readmeUrl: discovered.readmeUrl,
    categoryId: null,
    tags: [] as string[],
    featured: false,
    hidden: false,
    createdAt: now,
    updatedAt: now
}

// discoverRows() selects { skill, categoryName } via a leftJoin
const joinedRow = (
    row: Record<string, unknown>
): { skill: Record<string, unknown>; categoryName: null } => ({
    skill: row,
    categoryName: null
})

// repoFreshness() selects max(updatedAt) grouped per repo
const freshnessRow = (
    newest: Date
): Record<string, unknown> => ({
    repoOwner: skillRow.repoOwner,
    repoName: skillRow.repoName,
    repoBranch: skillRow.repoBranch,
    newest
})

const userSkillRow = {
    id: 'user-skill-1',
    userId: 'user-1',
    skillId: discovered.skillId,
    agentId: 'agent-1',
    runtimeId: 'runtime-1',
    framework: 'claude-code',
    enabled: true,
    installDir: 'pdf-toolkit',
    installedRevision: discovered.latestRevision,
    createdAt: now,
    updatedAt: now
}

const agentRow = {
    id: 'agent-1',
    userId: 'user-1',
    name: 'Claude Agent',
    framework: 'claude-code',
    runtime: 'sprites',
    status: 'running',
    runtimeId: 'runtime-1',
    internalId: 'claude-agent',
    workspacePath: '/workspace',
    mountPath: '/workspace',
    extras: {},
    createdAt: now,
    updatedAt: now
}

const runtimeRow = {
    id: 'runtime-1',
    userId: 'user-1',
    name: 'Claude Agent',
    framework: 'claude-code',
    kind: 'sprites',
    status: 'ready',
    mountPath: '/workspace',
    controlUiEnabled: true,
    dashboardEnabled: false,
    createdAt: now,
    updatedAt: now
}

const targetRow = { agent: agentRow, runtime: runtimeRow }

const hermesTargetRow = {
    agent: {
        ...agentRow,
        id: 'agent-hermes',
        name: 'Hermes Agent',
        framework: 'hermes',
        runtime: 'k8s',
        runtimeId: 'runtime-hermes',
        internalId: 'default'
    },
    runtime: {
        ...runtimeRow,
        id: 'runtime-hermes',
        name: 'Hermes Agent',
        framework: 'hermes',
        kind: 'k8s',
        mountPath: '/home/node/.hermes'
    }
}

test('SkillsService installs a discovered skill and resolves installDir collisions', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [targetRow], // resolveTarget()
        [], // customRepos()
        [], // findUserSkillBySkill()
        [{ id: 'existing', skillId: 'github:other/repo@main:skill' }],
        [] // suffixed installDir collision check
    )
    const materializer = new FakeMaterializer()
    const service = newService(db, materializer)

    const result = await service.install({
        userId: 'user-1',
        skillId: discovered.skillId,
        agentId: 'agent-1'
    })

    assert.equal(result.skillId, discovered.skillId)
    assert.equal(result.agentId, 'agent-1')
    assert.equal(result.runtimeId, 'runtime-1')
    assert.equal(result.enabled, true)
    assert.match(result.installDir, /^pdf-toolkit-[a-f0-9]{8}$/)
    assert.equal(db.insertedSkills[0].id, discovered.skillId)
    assert.equal(db.insertedUserSkills[0].agentId, 'agent-1')
    assert.equal(db.insertedUserSkills[0].runtimeId, 'runtime-1')
    assert.equal(db.insertedUserSkills[0].installDir, result.installDir)
    assert.deepEqual(materializer.calls, ['agent-1'])
})

test('SkillsService installs the same skill into two agents independently', async () => {
    const db = new FakeDb()
    const codexTarget = {
        agent: {
            ...agentRow,
            id: 'agent-2',
            name: 'Codex Agent',
            framework: 'codex',
            runtimeId: 'runtime-2'
        },
        runtime: {
            ...runtimeRow,
            id: 'runtime-2',
            name: 'Codex Agent',
            framework: 'codex'
        }
    }
    db.selectResults.push(
        [codexTarget], // resolveTarget()
        [], // customRepos()
        [], // findUserSkillBySkill()
        [] // base installDir collision check
    )
    const materializer = new FakeMaterializer()
    const service = newService(db, materializer)

    const result = await service.install({
        userId: 'user-1',
        skillId: discovered.skillId,
        agentId: 'agent-2'
    })

    assert.equal(result.framework, 'codex')
    assert.equal(db.insertedUserSkills[0].agentId, 'agent-2')
    assert.equal(db.insertedUserSkills[0].framework, 'codex')
    assert.equal(db.insertedUserSkills[0].runtimeId, 'runtime-2')
    assert.deepEqual(materializer.calls, ['agent-2'])
})

test('SkillsService installs skills into a Hermes runtime', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [hermesTargetRow], // resolveTarget()
        [], // customRepos()
        [], // findUserSkillBySkill()
        [] // base installDir collision check
    )
    const materializer = new FakeMaterializer()
    const service = newService(db, materializer)

    const result = await service.install({
        userId: 'user-1',
        skillId: discovered.skillId,
        agentId: 'agent-hermes'
    })

    assert.equal(result.framework, 'hermes')
    assert.equal(result.runtimeId, 'runtime-hermes')
    assert.equal(db.insertedUserSkills[0].agentId, 'agent-hermes')
    assert.equal(db.insertedUserSkills[0].framework, 'hermes')
    assert.equal(db.insertedUserSkills[0].runtimeId, 'runtime-hermes')
    assert.deepEqual(materializer.calls, ['agent-hermes'])
})

test('SkillsService scopes Hermes installs to profiles under the same runtime', async () => {
    const db = new FakeDb()
    const siblingTarget = {
        agent: {
            ...hermesTargetRow.agent,
            id: 'agent-hermes-profile',
            name: 'Hermes Profile',
            internalId: 'research'
        },
        runtime: hermesTargetRow.runtime
    }
    db.selectResults.push(
        [hermesTargetRow],
        [],
        [],
        [],
        [siblingTarget],
        [],
        [],
        []
    )
    const materializer = new FakeMaterializer()
    const service = newService(db, materializer)

    await service.install({
        userId: 'user-1',
        skillId: discovered.skillId,
        agentId: 'agent-hermes'
    })
    await service.install({
        userId: 'user-1',
        skillId: discovered.skillId,
        agentId: 'agent-hermes-profile'
    })

    assert.deepEqual(
        db.insertedUserSkills.map((row) => row.agentId),
        ['agent-hermes', 'agent-hermes-profile']
    )
    assert.deepEqual(
        db.insertedUserSkills.map((row) => row.runtimeId),
        ['runtime-hermes', 'runtime-hermes']
    )
    assert.deepEqual(materializer.calls, [
        'agent-hermes',
        'agent-hermes-profile'
    ])
})

test('SkillsService toggles an owned installed skill and re-materializes ready runtimes', async () => {
    const db = new FakeDb()
    db.selectResults.push([userSkillRow], [targetRow], [skillRow])
    db.updateResults.push([{ ...userSkillRow, enabled: false }])
    const materializer = new FakeMaterializer()
    const service = newService(db, materializer)

    const result = await service.update({
        userId: 'user-1',
        userSkillId: 'user-skill-1',
        enabled: false
    })

    assert.equal(result.id, 'user-skill-1')
    assert.equal(result.enabled, false)
    assert.deepEqual(db.updates[0].set, {
        enabled: false,
        updatedAt: db.updates[0].set.updatedAt
    })
    assert.deepEqual(materializer.calls, ['agent-1'])
})

test('SkillsService surfaces a failed materialization instead of reporting installed', async () => {
    const db = new FakeDb()
    db.selectResults.push([userSkillRow], [targetRow], [skillRow])
    db.updateResults.push([{ ...userSkillRow, enabled: true }])
    const materializer = new FakeMaterializer()
    materializer.outcomes = [
        {
            userSkillId: 'user-skill-1',
            status: 'failed',
            error: 'materialization timed out'
        }
    ]
    const service = newService(db, materializer)

    const result = await service.update({
        userId: 'user-1',
        userSkillId: 'user-skill-1',
        enabled: true
    })

    // the whole point of #341: a materializer failure must never read back as
    // installed — the caller sees failed with a usable reason.
    assert.equal(result.materializeStatus, 'failed')
    assert.equal(result.materializeError, 'materialization timed out')
    // enabling first records the pending intent so the row is never a silent
    // stale "installed" while the reconcile is still in flight.
    assert.equal(db.updates[0].set.materializeStatus, 'installing')
})

test('SkillsService reports installed once materialization succeeds', async () => {
    const db = new FakeDb()
    db.selectResults.push([userSkillRow], [targetRow], [skillRow])
    db.updateResults.push([{ ...userSkillRow, enabled: true }])
    const materializer = new FakeMaterializer()
    materializer.outcomes = [
        { userSkillId: 'user-skill-1', status: 'installed' }
    ]
    const service = newService(db, materializer)

    const result = await service.update({
        userId: 'user-1',
        userSkillId: 'user-skill-1',
        enabled: true
    })

    assert.equal(result.materializeStatus, 'installed')
    assert.equal(result.materializeError, null)
})

test('SkillsService install reconciles an already-installed skill in place (retry)', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [targetRow], // resolveTarget()
        [], // customRepos()
        [userSkillRow] // findUserSkillBySkill() → already installed
    )
    db.updateResults.push([{ ...userSkillRow, enabled: true }])
    const materializer = new FakeMaterializer()
    materializer.outcomes = [
        { userSkillId: 'user-skill-1', status: 'installed' }
    ]
    const service = newService(db, materializer)

    const result = await service.install({
        userId: 'user-1',
        skillId: discovered.skillId,
        agentId: 'agent-1'
    })

    // retry must reuse the same row, never insert a duplicate
    assert.equal(db.insertedUserSkills.length, 0)
    assert.equal(db.updates[0].set.materializeStatus, 'installing')
    assert.equal(result.id, 'user-skill-1')
    assert.equal(result.materializeStatus, 'installed')
})

test('SkillsService deletes an owned installed skill and re-materializes ready runtimes', async () => {
    const db = new FakeDb()
    db.selectResults.push([userSkillRow])
    const materializer = new FakeMaterializer()
    const service = newService(db, materializer)

    await service.delete('user-1', 'user-skill-1')

    assert.equal(db.deletes.length, 1)
    assert.equal(db.deletes[0].table, userSkills)
    assert.deepEqual(materializer.calls, ['agent-1'])
})

test('SkillsService discover marks installed state for the selected agent runtime', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [targetRow],
        [],
        [userSkillRow],
        [freshnessRow(new Date())], // repoFreshness(), fresh
        [joinedRow({ ...skillRow, updatedAt: new Date() })]
    )
    const discovery = new FakeDiscovery()
    const service = newService(db, new FakeMaterializer(), discovery)

    const result = await service.discover({
        userId: 'user-1',
        agentId: 'agent-1'
    })

    assert.equal(result[0].installed, true)
    assert.equal(result[0].enabled, true)
    assert.equal(result[0].userSkillId, 'user-skill-1')
    assert.equal(discovery.scanCalls.length, 0)
})

test('SkillsService discover triggers stale cache refresh without blocking', async () => {
    const db = new FakeDb()
    db.selectResults.push([targetRow], [], [], [], [])
    const discovery = new FakeDiscovery()
    discovery.scanPromise = new Promise<DiscoverableSkillSummary[]>(
        () => undefined
    )
    const service = newService(db, new FakeMaterializer(), discovery)

    const result = await service.discover({
        userId: 'user-1',
        agentId: 'agent-1'
    })

    assert.deepEqual(result, [])
    assert.equal(discovery.scanCalls.length, 1)
    assert.equal(discovery.scanCalls[0].repos[0].id, discovered.repoId)
})

test('SkillsService discover without agentId returns catalog with installed=false', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [], // customRepos()
        [freshnessRow(new Date())], // repoFreshness(), fresh
        [joinedRow({ ...skillRow, updatedAt: new Date() })] // discoverRows()
    )
    const discovery = new FakeDiscovery()
    const service = newService(db, new FakeMaterializer(), discovery)

    const result = await service.discover({ userId: 'user-1' })

    assert.equal(result.length, 1)
    assert.equal(result[0].installed, false)
    assert.equal(result[0].enabled, false)
    assert.equal(result[0].userSkillId, null)
    assert.equal(result[0].installDir, 'pdf-toolkit')
    assert.equal(discovery.scanCalls.length, 0)
})

test('SkillsService refreshDiscover without agentId refreshes the catalog', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [], // customRepos()
        [joinedRow({ ...skillRow, updatedAt: new Date() })] // discoverRows()
    )
    const discovery = new FakeDiscovery()
    const service = newService(db, new FakeMaterializer(), discovery)

    const result = await service.refreshDiscover({ userId: 'user-1' })

    assert.equal(discovery.scanCalls.length, 1)
    assert.equal(result.length, 1)
    assert.equal(result[0].installed, false)
    assert.equal(result[0].userSkillId, null)
})

test('SkillsService refreshDiscover scans selected repo and upserts cache rows', async () => {
    const db = new FakeDb()
    const refreshed = {
        ...discovered,
        latestRevision: 'rev-3'
    }
    db.selectResults.push(
        [targetRow],
        [],
        [],
        [joinedRow({ ...skillRow, latestRevision: refreshed.latestRevision })]
    )
    const discovery = new FakeDiscovery()
    discovery.scanResult = [refreshed]
    const service = newService(db, new FakeMaterializer(), discovery)

    const result = await service.refreshDiscover({
        userId: 'user-1',
        agentId: 'agent-1',
        repoId: discovered.repoId
    })

    assert.equal(discovery.scanCalls.length, 1)
    assert.equal(discovery.scanCalls[0].repos.length, 1)
    assert.equal(discovery.scanCalls[0].repos[0].id, discovered.repoId)
    assert.equal(db.insertedSkills[0].latestRevision, 'rev-3')
    assert.equal(result[0].latestRevision, 'rev-3')
})

test('SkillsService refreshDiscover dedupes concurrent refreshes for one repo', async () => {
    const db = new FakeDb()
    db.tableSelectResults.set(agents, [[targetRow], [targetRow]])
    db.tableSelectResults.set(skillRepos, [[], []])
    db.tableSelectResults.set(userSkills, [[], []])
    db.tableSelectResults.set(skills, [
        [joinedRow({ ...skillRow, updatedAt: new Date() })],
        [joinedRow({ ...skillRow, updatedAt: new Date() })]
    ])
    const discovery = new FakeDiscovery()
    let releaseScan!: () => void
    discovery.scanPromise = new Promise<DiscoverableSkillSummary[]>(
        (resolve) => {
            releaseScan = () => resolve([discovered])
        }
    )
    const service = newService(db, new FakeMaterializer(), discovery)

    const first = service.refreshDiscover({
        userId: 'user-1',
        agentId: 'agent-1',
        repoId: discovered.repoId
    })
    const second = service.refreshDiscover({
        userId: 'user-1',
        agentId: 'agent-1',
        repoId: discovered.repoId
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(discovery.scanCalls.length, 1)

    releaseScan()
    const results = await Promise.all([first, second])

    assert.equal(results[0][0].skillId, discovered.skillId)
    assert.equal(results[1][0].skillId, discovered.skillId)
})

test('SkillsService installed defaults to managed rows without Hermes runtime inventory', async () => {
    const db = new FakeDb()
    db.selectResults.push([hermesTargetRow], [])
    const materializer = new FakeMaterializer()
    materializer.inventory.set('agent-hermes', [
        {
            installDir: 'runtime-skill',
            name: 'Runtime Skill',
            description: 'Created by Hermes',
            sourcePath: 'runtime-skill'
        }
    ])
    const service = newService(db, materializer)

    const [group] = await service.installed('user-1')

    assert.equal(group.agent.id, 'agent-hermes')
    assert.equal(group.skills.length, 0)
    assert.deepEqual(materializer.inventoryCalls, [])
})

test('SkillsService installed merges Hermes runtime read-only skills', async () => {
    const db = new FakeDb()
    db.selectResults.push([hermesTargetRow], [])
    const materializer = new FakeMaterializer()
    materializer.inventory.set('agent-hermes', [
        {
            installDir: 'runtime-skill',
            name: 'Runtime Skill',
            description: 'Created by Hermes',
            sourcePath: 'runtime-skill'
        }
    ])
    const service = newService(db, materializer)

    const [group] = await service.installed('user-1', undefined, {
        includeRuntime: true
    })

    assert.equal(group.agent.id, 'agent-hermes')
    assert.equal(group.skills.length, 1)
    assert.equal(group.skills[0].source, 'runtime')
    assert.equal(group.skills[0].readonly, true)
    assert.equal(group.skills[0].installDir, 'runtime-skill')
    assert.deepEqual(materializer.inventoryCalls, ['agent-hermes'])
    assert.deepEqual(materializer.inventoryTimeouts, [3_000])
})

test('SkillsService installed prefers managed rows over duplicate runtime skills', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [hermesTargetRow],
        [
            {
                userSkill: {
                    ...userSkillRow,
                    agentId: 'agent-hermes',
                    runtimeId: 'runtime-hermes',
                    framework: 'hermes'
                },
                skill: skillRow
            }
        ]
    )
    const materializer = new FakeMaterializer()
    materializer.inventory.set('agent-hermes', [
        {
            installDir: 'pdf-toolkit',
            name: 'Runtime PDF',
            description: 'Runtime duplicate',
            sourcePath: 'pdf-toolkit'
        }
    ])
    const service = newService(db, materializer)

    const [group] = await service.installed('user-1', undefined, {
        includeRuntime: true
    })

    assert.equal(group.skills.length, 1)
    assert.equal(group.skills[0].source, 'nca')
    assert.equal(group.skills[0].readonly, false)
})

test('SkillsService installed returns managed rows when Hermes inventory fails', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [hermesTargetRow],
        [
            {
                userSkill: {
                    ...userSkillRow,
                    agentId: 'agent-hermes',
                    runtimeId: 'runtime-hermes',
                    framework: 'hermes'
                },
                skill: skillRow
            }
        ]
    )
    const materializer = new FakeMaterializer()
    materializer.inventoryError = new Error('pod unavailable')
    const service = newService(db, materializer)

    const [group] = await service.installed('user-1', undefined, {
        includeRuntime: true
    })

    assert.equal(group.skills.length, 1)
    assert.equal(group.skills[0].source, 'nca')
    assert.equal(group.inventoryError, 'pod unavailable')
})

test('SkillsService rejects missing or unsupported skill targets', async () => {
    const missingDb = new FakeDb()
    missingDb.selectResults.push([])
    await assert.rejects(
        newService(missingDb, new FakeMaterializer()).discover({
            userId: 'user-1',
            agentId: 'other-user-agent'
        }),
        /agent other-user-agent/
    )

    const unsupportedDb = new FakeDb()
    unsupportedDb.selectResults.push([
        {
            agent: { ...agentRow, framework: 'openclaw' },
            runtime: { ...runtimeRow, framework: 'openclaw' }
        }
    ])
    await assert.rejects(
        newService(unsupportedDb, new FakeMaterializer()).discover({
            userId: 'user-1',
            agentId: 'agent-1'
        }),
        BadRequestException
    )
})

test('SkillsService converts unsafe skill ids into BadRequestException', async () => {
    const db = new FakeDb()
    db.selectResults.push([targetRow], [])
    const service = newService(db, new FakeMaterializer())

    await assert.rejects(
        service.install({
            userId: 'user-1',
            skillId: 'not-a-skill-id',
            agentId: 'agent-1'
        }),
        BadRequestException
    )
})

const CURATION_COLUMNS = ['categoryId', 'tags', 'featured', 'hidden'] as const

test('SkillsService discovery upsert never touches curation columns', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [], // customRepos()
        [joinedRow({ ...skillRow })] // discoverRows()
    )
    const discovery = new FakeDiscovery()
    const service = newService(db, new FakeMaterializer(), discovery)

    await service.refreshDiscover({ userId: 'user-1' })

    assert.equal(db.conflictSets.length, 1)
    const keys = Object.keys(db.conflictSets[0].set)
    for (const column of CURATION_COLUMNS)
        assert.ok(
            !keys.includes(column),
            `discovery upsert set must not include admin-owned column "${column}"`
        )
})

test('SkillsService install upsert never touches curation columns', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [targetRow], // resolveTarget()
        [], // customRepos()
        [], // findUserSkillBySkill()
        [], // installDir collision check
        [] // suffixed installDir collision check
    )
    const service = newService(db, new FakeMaterializer())

    await service.install({
        userId: 'user-1',
        skillId: discovered.skillId,
        agentId: 'agent-1'
    })

    assert.equal(db.conflictSets.length, 1)
    const keys = Object.keys(db.conflictSets[0].set)
    for (const column of CURATION_COLUMNS)
        assert.ok(
            !keys.includes(column),
            `install upsert set must not include admin-owned column "${column}"`
        )
    // install re-verified the skill live, so it must clear any stale missing
    // flag — otherwise the just-installed skill stays 404 in the catalog.
    assert.equal(db.conflictSets[0].set.missingSince, null)
})

test('SkillsService refreshDiscover flags skills the scan omitted as missing', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [], // customRepos()
        [joinedRow({ ...skillRow, updatedAt: new Date() })] // discoverRows()
    )
    const discovery = new FakeDiscovery()
    discovery.scanResult = [discovered]
    const service = newService(db, new FakeMaterializer(), discovery)

    await service.refreshDiscover({ userId: 'user-1' })

    const missingUpdate = db.updates.find(
        (u) => 'missingSince' in u.set && u.set.missingSince !== null
    )
    assert.ok(missingUpdate, 'expected a markMissing update after a full scan')
})

test('SkillsService refreshDiscover skips missing-marking for a truncated scan', async () => {
    const db = new FakeDb()
    db.selectResults.push(
        [], // customRepos()
        [joinedRow({ ...skillRow, updatedAt: new Date() })] // discoverRows()
    )
    const discovery = new FakeDiscovery()
    discovery.scanResult = [discovered]
    discovery.truncatedRepoIds = [discovered.repoId]
    const service = newService(db, new FakeMaterializer(), discovery)

    await service.refreshDiscover({ userId: 'user-1' })

    const missingUpdate = db.updates.find(
        (u) => 'missingSince' in u.set && u.set.missingSince !== null
    )
    assert.equal(
        missingUpdate,
        undefined,
        'a truncated (partial) scan must not mark skills missing'
    )
})

const newService = (
    db: FakeDb,
    materializer: FakeMaterializer,
    discovery: FakeDiscovery = new FakeDiscovery()
): SkillsService =>
    new SkillsService(db as never, discovery as never, materializer as never)

class FakeDiscovery {
    scanCalls: Array<{ repos: Array<{ id: string }> }> = []
    scanResult: DiscoverableSkillSummary[] = [discovered]
    scanPromise: Promise<DiscoverableSkillSummary[]> | null = null
    truncatedRepoIds: string[] = []

    async builtinRepos(): Promise<
        Array<{
            id: string
            owner: string
            name: string
            branch: string
            enabled: boolean
            readonly: boolean
            createdAt: null
            updatedAt: null
        }>
    > {
        return [
            {
                id: 'builtin:anthropics/skills@main',
                owner: 'anthropics',
                name: 'skills',
                branch: 'main',
                enabled: true,
                readonly: true,
                createdAt: null,
                updatedAt: null
            }
        ]
    }

    async discoverOne(
        _repos: unknown,
        skillId: string
    ): Promise<DiscoverableSkillSummary | null> {
        if (skillId !== discovered.skillId) throw new Error('invalid skill id')
        return discovered
    }

    async scanRepos(input: { repos: Array<{ id: string }> }): Promise<{
        rows: DiscoverableSkillSummary[]
        truncatedRepoIds: string[]
    }> {
        this.scanCalls.push(input)
        const rows = this.scanPromise
            ? await this.scanPromise
            : this.scanResult
        return { rows, truncatedRepoIds: this.truncatedRepoIds }
    }
}

class FakeMaterializer {
    calls: string[] = []
    outcomes: SkillOutcome[] = []
    inventoryCalls: string[] = []
    inventoryTimeouts: Array<number | undefined> = []
    inventory = new Map<string, unknown[]>()
    inventoryError: Error | null = null

    async materializeAgent(agentId: string): Promise<SkillOutcome[]> {
        this.calls.push(agentId)
        return this.outcomes
    }

    async listHermesRuntimeSkills(input: {
        agent: { id: string }
        timeoutMs?: number
    }): Promise<unknown[]> {
        this.inventoryCalls.push(input.agent.id)
        this.inventoryTimeouts.push(input.timeoutMs)
        if (this.inventoryError) throw this.inventoryError
        return this.inventory.get(input.agent.id) ?? []
    }
}

class FakeDb {
    selectResults: unknown[][] = []
    tableSelectResults = new Map<unknown, unknown[][]>()
    updateResults: unknown[][] = []
    insertedSkills: Array<Record<string, unknown>> = []
    insertedUserSkills: Array<Record<string, unknown>> = []
    updates: Array<{ table: unknown; set: Record<string, unknown> }> = []
    deletes: Array<{ table: unknown }> = []
    conflictSets: Array<{ table: unknown; set: Record<string, unknown> }> = []

    select(): FakeQuery {
        return new FakeQuery(this, 'select')
    }

    insert(table: unknown): FakeQuery {
        return new FakeQuery(this, 'insert', table)
    }

    update(table: unknown): FakeQuery {
        return new FakeQuery(this, 'update', table)
    }

    delete(table: unknown): FakeQuery {
        this.deletes.push({ table })
        return new FakeQuery(this, 'delete', table)
    }

    nextSelect(table?: unknown): unknown[] {
        const tableQueue = table
            ? this.tableSelectResults.get(table)
            : undefined
        if (tableQueue?.length) return tableQueue.shift() ?? []
        return this.selectResults.shift() ?? []
    }

    nextUpdate(): unknown[] {
        return this.updateResults.shift() ?? []
    }
}

class FakeQuery implements PromiseLike<unknown[]> {
    private rowValues: Record<string, unknown> = {}
    private fromTable?: unknown

    constructor(
        private readonly db: FakeDb,
        private readonly kind: 'select' | 'insert' | 'update' | 'delete',
        private readonly table?: unknown
    ) {}

    from(table?: unknown): this {
        this.fromTable = table
        return this
    }

    innerJoin(): this {
        return this
    }

    leftJoin(): this {
        return this
    }

    where(): this {
        return this
    }

    orderBy(): this {
        return this
    }

    groupBy(): this {
        return this
    }

    limit(): this {
        return this
    }

    offset(): this {
        return this
    }

    values(values: Record<string, unknown>): this {
        this.rowValues = values
        return this
    }

    onConflictDoUpdate(config: { set: Record<string, unknown> }): this {
        this.db.conflictSets.push({ table: this.table, set: config.set })
        return this
    }

    set(patch: Record<string, unknown>): this {
        this.db.updates.push({ table: this.table, set: patch })
        return this
    }

    returning(): Promise<unknown[]> {
        if (this.kind === 'insert') return Promise.resolve([this.insertedRow()])
        if (this.kind === 'update') return Promise.resolve(this.db.nextUpdate())
        return Promise.resolve([])
    }

    then<TResult1 = unknown[], TResult2 = never>(
        onfulfilled?:
            | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
            | undefined
            | null,
        onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | undefined
            | null
    ): PromiseLike<TResult1 | TResult2> {
        const value =
            this.kind === 'select'
                ? this.db.nextSelect(this.fromTable)
                : ([] as unknown[])
        return Promise.resolve(value).then(onfulfilled, onrejected)
    }

    private insertedRow(): Record<string, unknown> {
        if (this.table === skills) {
            const row = { ...this.rowValues, createdAt: now, updatedAt: now }
            this.db.insertedSkills.push(row)
            return row
        }
        if (this.table === userSkills) {
            const row = { ...this.rowValues, createdAt: now, updatedAt: now }
            this.db.insertedUserSkills.push(row)
            return row
        }
        if (this.table === skillRepos)
            return { ...this.rowValues, createdAt: now, updatedAt: now }
        return { ...this.rowValues }
    }
}
