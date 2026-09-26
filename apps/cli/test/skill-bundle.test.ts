import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { MANYFOLD_CLI_USAGE_SKILL_ID } from '@manyfold/shared'
import {
    buildSkillBundle,
    compareSkillBundles,
    fetchPublishedSkill,
    pluginSkillDir,
    readSkillBundle,
    SKILL_NAME,
    skillBundleVersion,
    writeSkillBundle,
    type SkillBundle
} from '../scripts/skill-bundle'

test('plugin ships the complete canonical skill under the stable default-install name', () => {
    assert.equal(
        MANYFOLD_CLI_USAGE_SKILL_ID,
        'github:protagolabs/manyfold-skills@main:skills/manyfold-cli-usage'
    )
    const installed = readSkillBundle(pluginSkillDir)
    const expected = buildSkillBundle(skillBundleVersion(installed))
    assert.equal(SKILL_NAME, 'manyfold-cli-usage')
    assert.deepEqual(compareSkillBundles(expected, installed), [])
    for (const [path, content] of Object.entries(expected)) {
        for (const [, link] of content.matchAll(/\]\(([^)]+\.md)\)/g)) {
            const target = posix.normalize(
                posix.join(posix.dirname(path), link)
            )
            assert.ok(
                target in expected,
                `${path} has an unavailable reference: ${link}`
            )
        }
    }
})

test('bundle updates replace obsolete references without retaining a second skill', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-skill-bundle-'))
    try {
        const standalone = join(dir, 'standalone', SKILL_NAME)
        const plugin = join(dir, 'plugin', SKILL_NAME)
        mkdirSync(join(plugin, 'references'), { recursive: true })
        writeFileSync(join(plugin, 'references/obsolete.md'), 'stale')
        const expected = buildSkillBundle('0.3.0')
        writeSkillBundle(standalone, expected)
        writeSkillBundle(plugin, expected)
        assert.deepEqual(readSkillBundle(plugin), readSkillBundle(standalone))
        assert.equal(skillBundleVersion(readSkillBundle(plugin)), '0.3.0')
        assert.ok(!('references/obsolete.md' in readSkillBundle(plugin)))
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('full-directory drift detects reference changes even with an identical entrypoint', () => {
    const expected = buildSkillBundle()
    const actual: SkillBundle = {
        ...expected,
        'references/web-routes.md': 'outdated routes',
        'references/unexpected.md': 'unpublished file'
    }
    delete actual['references/workbench.md']
    assert.equal(actual['SKILL.md'], expected['SKILL.md'])
    assert.deepEqual(compareSkillBundles(expected, actual), [
        'unexpected: references/unexpected.md',
        'changed: references/web-routes.md',
        'missing: references/workbench.md'
    ])
})

test('published verification pins every file to one revision and checks the references', async () => {
    const source = buildSkillBundle('0.3.0')
    const upstream: SkillBundle = {
        ...source,
        'references/web-routes.md': 'stale upstream reference'
    }
    const calls: string[] = []
    const prefix = 'skills/manyfold-cli-usage/'
    const fetcher: typeof fetch = async (input) => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith('/commits/main'))
            return Response.json({ sha: 'commit-one' })
        if (url.endsWith('/git/trees/commit-one?recursive=1'))
            return Response.json({
                truncated: false,
                tree: Object.keys(upstream).map((path) => ({
                    type: 'blob',
                    mode: '100644',
                    path: prefix + path
                }))
            })
        const rawPrefix =
            'https://raw.githubusercontent.com/protagolabs/manyfold-skills/commit-one/' +
            prefix
        assert.ok(url.startsWith(rawPrefix), 'all reads use the pinned commit')
        return new Response(upstream[url.slice(rawPrefix.length)])
    }
    const published = await fetchPublishedSkill(
        MANYFOLD_CLI_USAGE_SKILL_ID,
        fetcher
    )
    assert.equal(published.version, '0.3.0')
    assert.equal(published.revision, 'commit-one')
    assert.equal(calls.length, Object.keys(source).length + 2)
    assert.deepEqual(
        compareSkillBundles(
            buildSkillBundle(published.version),
            published.files
        ),
        ['changed: references/web-routes.md']
    )
})

test('a truncated published tree cannot be reported as a matching bundle', async () => {
    const fetcher: typeof fetch = async (input) =>
        Response.json(
            String(input).includes('/commits/')
                ? { sha: 'commit-one' }
                : { truncated: true, tree: [] }
        )
    await assert.rejects(
        fetchPublishedSkill(MANYFOLD_CLI_USAGE_SKILL_ID, fetcher),
        /truncated/
    )
})

test('bundle checks treat object-property names as file paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-skill-path-'))
    try {
        writeFileSync(join(dir, '__proto__'), 'unexpected')
        writeFileSync(join(dir, 'constructor'), 'unexpected')
        assert.deepEqual(compareSkillBundles({}, readSkillBundle(dir)), [
            'unexpected: __proto__',
            'unexpected: constructor'
        ])
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
