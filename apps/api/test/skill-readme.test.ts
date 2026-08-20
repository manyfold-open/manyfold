import assert from 'node:assert/strict'
import test from 'node:test'
import {
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { SkillDiscoveryService } from '../src/modules/skills/skill-discovery.service'
import { SkillsService } from '../src/modules/skills/skills.service'

const now = new Date('2026-04-25T12:00:00.000Z')

const skillRow = {
    id: 'github:anthropics/skills@main:skills/pdf',
    name: 'PDF Toolkit',
    description: 'Work with PDF files',
    repoOwner: 'anthropics',
    repoName: 'skills',
    repoBranch: 'main',
    sourcePath: 'skills/pdf',
    latestRevision: 'rev-2',
    readmeUrl: null,
    categoryId: null,
    tags: [] as string[],
    featured: false,
    hidden: false,
    createdAt: now,
    updatedAt: now
}

class FakeDb {
    selectResults: unknown[][] = []

    select(): FakeQuery {
        return new FakeQuery(this)
    }

    nextSelect(): unknown[] {
        return this.selectResults.shift() ?? []
    }
}

class FakeQuery implements PromiseLike<unknown[]> {
    constructor(private readonly db: FakeDb) {}

    from(): this {
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

    limit(): this {
        return this
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
        return Promise.resolve(this.db.nextSelect()).then(
            onfulfilled,
            onrejected
        )
    }
}

class FakeReadmeDiscovery {
    files = new Map<string, string | null>()
    calls: string[] = []

    async builtinRepos(): Promise<unknown[]> {
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

    async fetchRepoFile(
        _repo: { owner: string; name: string; branch: string },
        path: string
    ): Promise<string | null> {
        this.calls.push(path)
        return this.files.get(path) ?? null
    }
}

const newService = (db: FakeDb, discovery: FakeReadmeDiscovery): SkillsService =>
    new SkillsService(db as never, discovery as never, {} as never)

const pushReadmeLookup = (db: FakeDb, row: Record<string, unknown>): void => {
    db.selectResults.push(
        [], // customRepos()
        [{ skill: row, categoryName: null }] // visibleSkillRow()
    )
}

test('SkillsService readme fetches SKILL.md and caches by revision', async () => {
    const db = new FakeDb()
    pushReadmeLookup(db, skillRow)
    pushReadmeLookup(db, skillRow)
    const discovery = new FakeReadmeDiscovery()
    discovery.files.set('skills/pdf/SKILL.md', '# PDF Toolkit')
    const service = newService(db, discovery)

    const first = await service.readme('user-1', skillRow.id)
    assert.equal(first.content, '# PDF Toolkit')
    assert.equal(first.path, 'skills/pdf/SKILL.md')
    assert.equal(first.revision, 'rev-2')
    assert.deepEqual(
        first.documents.map((d) => d.source),
        ['skill']
    )

    const second = await service.readme('user-1', skillRow.id)
    assert.equal(second.content, '# PDF Toolkit')
    // Both candidate paths are probed on the cache miss (SKILL.md + README.md);
    // the second call is served from cache and probes nothing.
    assert.equal(discovery.calls.length, 2)
})

test('SkillsService readme returns both SKILL.md and README.md when present', async () => {
    const db = new FakeDb()
    pushReadmeLookup(db, skillRow)
    const discovery = new FakeReadmeDiscovery()
    discovery.files.set('skills/pdf/SKILL.md', '# PDF Skill')
    discovery.files.set('skills/pdf/README.md', '# PDF Readme')
    const service = newService(db, discovery)

    const result = await service.readme('user-1', skillRow.id)
    // SKILL.md is the primary/default document, README.md is offered alongside.
    assert.equal(result.path, 'skills/pdf/SKILL.md')
    assert.deepEqual(
        result.documents.map((d) => ({ source: d.source, path: d.path })),
        [
            { source: 'skill', path: 'skills/pdf/SKILL.md' },
            { source: 'readme', path: 'skills/pdf/README.md' }
        ]
    )
})

test('SkillsService readme falls back to README.md when SKILL.md is missing', async () => {
    const db = new FakeDb()
    pushReadmeLookup(db, skillRow)
    const discovery = new FakeReadmeDiscovery()
    discovery.files.set('skills/pdf/README.md', '# PDF Toolkit')
    const service = newService(db, discovery)

    const result = await service.readme('user-1', skillRow.id)
    assert.equal(result.path, 'skills/pdf/README.md')
    assert.deepEqual(discovery.calls, [
        'skills/pdf/SKILL.md',
        'skills/pdf/README.md'
    ])
})

test('SkillsService readme rejects when no candidate file exists', async () => {
    const db = new FakeDb()
    pushReadmeLookup(db, skillRow)
    const service = newService(db, new FakeReadmeDiscovery())

    await assert.rejects(
        service.readme('user-1', skillRow.id),
        NotFoundException
    )
})

test('SkillsService readme refetches when the discovered revision moves', async () => {
    const db = new FakeDb()
    pushReadmeLookup(db, skillRow)
    pushReadmeLookup(db, { ...skillRow, latestRevision: 'rev-3' })
    const discovery = new FakeReadmeDiscovery()
    discovery.files.set('skills/pdf/SKILL.md', '# PDF Toolkit')
    const service = newService(db, discovery)

    await service.readme('user-1', skillRow.id)
    const refreshed = await service.readme('user-1', skillRow.id)

    assert.equal(refreshed.revision, 'rev-3')
    // Two cache misses, each probing both candidate paths.
    assert.equal(discovery.calls.length, 4)
})

test('SkillsService readme resolves repo-root skills from the repo root', async () => {
    const db = new FakeDb()
    pushReadmeLookup(db, {
        ...skillRow,
        id: 'github:anthropics/skills@main:.',
        sourcePath: '.'
    })
    const discovery = new FakeReadmeDiscovery()
    discovery.files.set('README.md', '# Root skill')
    const service = newService(db, discovery)

    const result = await service.readme(
        'user-1',
        'github:anthropics/skills@main:.'
    )
    assert.equal(result.path, 'README.md')
})

test('SkillsService readme 404s for hidden or out-of-repo skills', async () => {
    const hiddenDb = new FakeDb()
    hiddenDb.selectResults.push([], []) // customRepos, visibleSkillRow miss
    await assert.rejects(
        newService(hiddenDb, new FakeReadmeDiscovery()).readme(
            'user-1',
            skillRow.id
        ),
        NotFoundException
    )

    const foreignDb = new FakeDb()
    foreignDb.selectResults.push(
        [],
        [
            {
                skill: { ...skillRow, repoOwner: 'someone-else' },
                categoryName: null
            }
        ]
    )
    await assert.rejects(
        newService(foreignDb, new FakeReadmeDiscovery()).readme(
            'user-1',
            skillRow.id
        ),
        NotFoundException
    )
})

const discoveryWithFetch = (): SkillDiscoveryService =>
    new SkillDiscoveryService(
        new ConfigService({}),
        { getBuiltinSkillRepos: async () => ({ repos: [] }) } as never
    )

const repo = { owner: 'anthropics', name: 'skills', branch: 'main' }

test('SkillDiscoveryService fetchRepoFile returns null on 404', async (t) => {
    const original = globalThis.fetch
    t.after(() => {
        globalThis.fetch = original
    })
    globalThis.fetch = async () =>
        new Response('{"message":"Not Found"}', { status: 404 })

    const result = await discoveryWithFetch().fetchRepoFile(repo, 'README.md')
    assert.equal(result, null)
})

test('SkillDiscoveryService fetchRepoFile decodes base64 content', async (t) => {
    const original = globalThis.fetch
    t.after(() => {
        globalThis.fetch = original
    })
    globalThis.fetch = async () =>
        new Response(
            JSON.stringify({
                encoding: 'base64',
                content: Buffer.from('# hello').toString('base64')
            }),
            { status: 200 }
        )

    const result = await discoveryWithFetch().fetchRepoFile(repo, 'README.md')
    assert.equal(result, '# hello')
})

test('SkillDiscoveryService fetchRepoFile surfaces other failures as 503', async (t) => {
    const original = globalThis.fetch
    t.after(() => {
        globalThis.fetch = original
    })
    globalThis.fetch = async () => new Response('boom', { status: 500 })
    await assert.rejects(
        discoveryWithFetch().fetchRepoFile(repo, 'README.md'),
        ServiceUnavailableException
    )

    globalThis.fetch = async () =>
        new Response('rate limited', {
            status: 403,
            headers: { 'x-ratelimit-remaining': '0' }
        })
    await assert.rejects(
        discoveryWithFetch().fetchRepoFile(repo, 'README.md'),
        /rate limit/
    )
})
