import assert from 'node:assert/strict'
import test from 'node:test'
import './helpers/narranexus-version'
import {
    SkillDiscoveryService,
    type DiscoveryRepo
} from '../src/modules/skills/skill-discovery.service'
import { githubFixture, REVISION_A } from './helpers/github-discovery-fixture'
import { GitHubRequestError } from '../src/common/github-request-error'
import {
    fetchSkillSource,
    withSkillRequestBudget,
    SKILL_SCAN_LIMITS
} from '../src/modules/skills/github-skill-source'
import { CliVersionCatalogService } from '../src/modules/daemon/cli-version-catalog.service'
import { FrameworkVersionsService } from '../src/modules/framework-versions/framework-versions.service'

const repo = (name = 'skills'): DiscoveryRepo => ({
    id: `builtin:fixture-owner/${name}@main`,
    owner: 'fixture-owner',
    name,
    branch: 'main',
    enabled: true,
    readonly: true,
    createdAt: null,
    updatedAt: null
})
const service = () =>
    new SkillDiscoveryService(
        { get: () => 'synthetic-platform-credential' } as never,
        { getBuiltinSkillRepos: async () => ({ repos: [] }) } as never
    )

test('arbitrary public repository requests never carry the ambient platform credential', async (t) => {
    const h = await githubFixture(t)
    const discovery = service()
    await discovery.fetchDefaultBranch('fixture-owner', 'skills')
    await discovery.resolveRepoTree({
        owner: 'fixture-owner',
        name: 'skills',
        ref: 'main'
    })
    await discovery.fetchRepoFileRaw(
        { owner: 'fixture-owner', name: 'skills', branch: REVISION_A },
        'SKILL.md'
    )
    assert.ok(h.requests.length >= 4)
    for (const request of h.requests)
        assert.equal(request.headers.authorization, undefined)
})

test('a discovery scan reads every skill at its resolved immutable commit', async (t) => {
    const h = await githubFixture(t)
    const result = await service().scanRepos({ repos: [repo()] })
    assert.equal(result.rows[0].latestRevision, REVISION_A)
    const file = h.requests.find(
        (request) =>
            request.path.includes('/contents/') ||
            request.host === 'raw.githubusercontent.com'
    )
    assert.ok(file)
    assert.ok(file.path.includes(REVISION_A), file.path)
    assert.ok(!file.path.includes('ref=main'))
})

test('changed scans have one shared outbound bound across repositories', async (t) => {
    const h = await githubFixture(t)
    h.state.paths = Array.from(
        { length: 15 },
        (_, index) => `skills/${index}/SKILL.md`
    )
    h.state.delayMs = 15
    await service().scanRepos({
        repos: [repo('one'), repo('two'), repo('three')]
    })
    assert.ok(h.state.peak <= 8, `outbound peak ${h.state.peak} exceeds 8`)
})

for (const [status, headers, body, classification] of [
    [401, {}, 'Bad credentials fixture-private-response', 'credential_invalid'],
    [
        403,
        {},
        'personal access token lifetime exceeds organization policy fixture-private-response',
        'credential_policy'
    ],
    [
        403,
        { 'x-ratelimit-remaining': '0' },
        'fixture-private-response',
        'rate_limited'
    ],
    [403, { 'retry-after': '10' }, 'fixture-private-response', 'rate_limited'],
    [403, {}, 'fixture-private-response', 'permission_denied'],
    [503, {}, 'fixture-private-response', 'upstream']
] as const) {
    test(`GitHub ${status}/${classification} is classified without exporting upstream details or retrying`, async (t) => {
        const h = await githubFixture(t)
        h.state.failPath = '/commits/'
        h.state.failStatus = status
        h.state.failHeaders = headers
        h.state.failBody = body
        await assert.rejects(
            service().scanRepos({ repos: [repo()] }),
            (error: unknown) => {
                assert.ok(error instanceof GitHubRequestError)
                assert.equal(error.classification, classification)
                for (const forbidden of [
                    'fixture-private-response',
                    'fixture-owner',
                    'Authorization',
                    'synthetic-platform-credential'
                ])
                    assert.ok(
                        !JSON.stringify(error.getResponse()).includes(forbidden)
                    )
                return true
            }
        )
        assert.equal(h.requests.length, 1)
    })
}

test('an inherited scan budget still honors a child cancellation and releases queued slots', async (t) => {
    const h = await githubFixture(t)
    h.state.delayMs = 150
    const controller = new AbortController()
    const pending = withSkillRequestBudget(async (parent) => {
        const child = withSkillRequestBudget(async () => {
            await Promise.all(
                Array.from({ length: 12 }, () =>
                    fetchSkillSource(
                        'https://api.github.com/repos/fixture-owner/skills'
                    )
                )
            )
        }, controller.signal)
        while (h.requests.length < 8)
            await new Promise((resolve) => setTimeout(resolve, 5))
        controller.abort()
        await assert.rejects(child, GitHubRequestError)
        assert.ok(parent.requests <= 8)
    })
    await pending
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(h.requests.length, 8)
    h.state.delayMs = 0
    await service().fetchDefaultBranch('fixture-owner', 'skills')
    assert.equal(h.requests.length, 9)
})

test('request and file size budgets fail before an unbounded scan', async (t) => {
    const h = await githubFixture(t)
    await assert.rejects(
        withSkillRequestBudget(async (budget) => {
            budget.requests = SKILL_SCAN_LIMITS.requests
            await service().fetchDefaultBranch('fixture-owner', 'skills')
        }),
        GitHubRequestError
    )
    assert.equal(h.requests.length, 0)
    await assert.rejects(
        fetchSkillSource(
            'https://raw.githubusercontent.com/fixture-owner/skills/' +
                REVISION_A +
                '/SKILL.md',
            2
        ),
        GitHubRequestError
    )
})

test('redirects stay anonymous, bounded and confined to GitHub public content hosts', async (t) => {
    const h = await githubFixture(t)
    h.state.failPath = '/commits/'
    h.state.failStatus = 301
    h.state.failHeaders = {
        location:
            'https://api.github.com/repos/fixture-owner/skills/commits/redirected'
    }
    await assert.rejects(
        service().scanRepos({ repos: [repo()] }),
        GitHubRequestError
    )
    assert.equal(h.requests.length, 3)
    assert.ok(
        h.requests.every(
            (request) => request.headers.authorization === undefined
        )
    )
    h.requests.length = 0
    h.state.failHeaders = {
        location: 'https://outside.example.invalid/private'
    }
    await assert.rejects(
        service().scanRepos({ repos: [repo()] }),
        GitHubRequestError
    )
    assert.equal(h.requests.length, 1)
})

test('fixed CLI and allowlisted framework catalog consumers retain their scoped platform credential route', async (t) => {
    const calls: Array<{ url: string; authorization: string | null }> = []
    t.mock.method(
        globalThis,
        'fetch',
        async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input)
            calls.push({
                url,
                authorization: new Headers(init?.headers).get('authorization')
            })
            return new Response(
                JSON.stringify(
                    url.includes('/releases')
                        ? [{ tag_name: 'cli-v3.0.2' }]
                        : [{ name: 'v9.1.0' }]
                ),
                { status: 200 }
            )
        }
    )
    const config = {
        get: (key: string) =>
            key === 'GITHUB_TOKEN'
                ? 'synthetic-trusted-credential'
                : 'production'
    }
    const cli = new CliVersionCatalogService(
        config as never,
        {
            getCachedCliMinimumVersion: async () => ({ minVersion: null })
        } as never
    )
    assert.deepEqual((await cli.getCachedCatalog()).stable, ['3.0.2'])
    const versions = new FrameworkVersionsService(
        {
            select: () => ({
                from: () => ({ where: () => ({ limit: async () => [] }) })
            }),
            insert: () => ({
                values: () => ({ onConflictDoUpdate: async () => {} })
            })
        } as never,
        config as never,
        {
            getCachedFrameworkDefaultVersions: async () => ({
                defaults: {},
                sourceRepos: { narranexus: 'user-supplied/untrusted' }
            })
        } as never
    )
    await versions.refreshFramework('narranexus')
    assert.equal(calls.length, 2)
    assert.ok(
        calls[0].url.startsWith(
            'https://api.github.com/repos/manyfold-open/manyfold/releases?'
        )
    )
    assert.ok(
        calls[1].url.startsWith(
            'https://api.github.com/repos/NetMindAI-Open/NarraNexus/tags?'
        )
    )
    assert.ok(
        calls.every(
            (call) =>
                call.authorization === 'Bearer synthetic-trusted-credential'
        )
    )
})
