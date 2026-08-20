import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentFramework } from '../src/constants'
import {
    NARRANEXUS_REPO_CANDIDATES,
    defaultFrameworkRepo,
    frameworkRepoCandidates,
    frameworkRepoCloneUrl,
    resolveFrameworkRepo
} from '../src/frameworkVersionSources'
import { versionedFrameworks } from '../src/framework-versions'

const UPSTREAM = 'NetMindAI-Open/NarraNexus'
const FORK = 'protagolabs/NarraNexus'

// Frameworks whose install clone URL is built from the resolved slug. Hermes is
// deliberately absent: its bootstrap pipes NousResearch's install.sh, which
// clones a repository named inside that script, so moving its catalog would not
// move its clone.
const SLUG_DRIVEN_CLONE: AgentFramework[] = ['narranexus']

test('an unconfigured platform resolves to the default repository', () => {
    assert.equal(resolveFrameworkRepo('narranexus'), UPSTREAM)
    assert.equal(resolveFrameworkRepo('narranexus', null), UPSTREAM)
    assert.equal(resolveFrameworkRepo('narranexus', {}), UPSTREAM)
    assert.equal(
        resolveFrameworkRepo('narranexus', { sourceRepos: {} }),
        UPSTREAM
    )
    assert.equal(defaultFrameworkRepo('narranexus'), UPSTREAM)
})

test('an allowlisted override is honoured', () => {
    assert.equal(
        resolveFrameworkRepo('narranexus', {
            sourceRepos: { narranexus: FORK }
        }),
        FORK
    )
})

// A candidate can be retired in a later deploy while a settings row still names
// it. Honouring the stored slug would make the allowlist un-revocable.
test('a slug that has left the allowlist falls back to the default', () => {
    assert.equal(
        resolveFrameworkRepo('narranexus', {
            sourceRepos: { narranexus: 'attacker/NarraNexus' }
        }),
        UPSTREAM
    )
    assert.equal(
        resolveFrameworkRepo('narranexus', { sourceRepos: { narranexus: '' } }),
        UPSTREAM
    )
})

test('frameworks with no candidates resolve to null', () => {
    for (const framework of ['claude-code', 'codex', 'gemini-cli', 'openclaw'])
        assert.equal(resolveFrameworkRepo(framework), null, framework)
    for (const framework of ['dify', 'langflow', 'a2a', 'nope']) {
        assert.deepEqual(frameworkRepoCandidates(framework), [])
        assert.equal(defaultFrameworkRepo(framework), null)
    }
})

test('the clone URL rejects anything that could reach the shell', () => {
    for (const bad of [
        'foo/bar; rm -rf /',
        'foo/../bar',
        'foo bar/baz',
        '$(id)/x',
        'foo/bar`id`',
        'foo/bar\nrm -rf /',
        'foo',
        '/foo/bar',
        'foo/bar/baz'
    ])
        assert.throws(
            () => frameworkRepoCloneUrl(bad),
            /invalid framework repo slug/,
            bad
        )
})

// A candidate whose URL named a different org than its slug would reintroduce
// exactly the catalog/clone split this module exists to prevent.
test('every candidate URL names that candidate', () => {
    for (const framework of versionedFrameworks)
        for (const candidate of frameworkRepoCandidates(framework))
            assert.equal(
                frameworkRepoCloneUrl(candidate.repo),
                `https://github.com/${candidate.repo}.git`,
                candidate.repo
            )
})

test('candidate slugs are unique and the default is first', () => {
    for (const framework of versionedFrameworks) {
        const repos = frameworkRepoCandidates(framework).map((c) => c.repo)
        assert.equal(new Set(repos).size, repos.length, framework)
        if (repos.length)
            assert.equal(defaultFrameworkRepo(framework), repos[0], framework)
    }
})

// Guards the asymmetry that decided hermes's single candidate: offering a
// choice for a framework whose clone ignores the slug would move the picker
// without moving the install.
test('only slug-driven clone paths may offer a choice', () => {
    for (const framework of versionedFrameworks)
        if (frameworkRepoCandidates(framework).length > 1)
            assert.ok(
                SLUG_DRIVEN_CLONE.includes(framework),
                `${framework} offers multiple repositories but its clone path is not slug-driven`
            )
})

test('narranexus offers both published repositories', () => {
    assert.deepEqual(
        NARRANEXUS_REPO_CANDIDATES.map((c) => c.repo),
        [UPSTREAM, FORK]
    )
})
