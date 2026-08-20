import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import { strToU8, zipSync } from 'fflate'
import {
    computeContentHash,
    ensureSkillFrontmatter,
    parseImportUrl,
    parseSkillArchive,
    setFrontmatterFields,
    shallowestSkillMdRoot,
    shouldIgnoreImportPath
} from '../src/modules/skills/library-skills.service'
import {
    assertSafeLibraryFilePath,
    libraryStoreKey
} from '../src/modules/skills/skill-utils'

const zip = (entries: Record<string, string>): Buffer =>
    Buffer.from(
        zipSync(
            Object.fromEntries(
                Object.entries(entries).map(([path, content]) => [
                    path,
                    strToU8(content)
                ])
            )
        )
    )

test('ensureSkillFrontmatter keeps content that already has a name', () => {
    const content = '---\nname: my-skill\n---\n\n# Hi\n'
    assert.equal(ensureSkillFrontmatter(content, 'other', null), content)
})

test('ensureSkillFrontmatter synthesizes a block when missing', () => {
    const out = ensureSkillFrontmatter('# Hi\n\nBody\n', 'my-skill', 'A desc')
    assert.match(out, /^---\nname: "my-skill"\ndescription: "A desc"\n---\n/)
    assert.match(out, /# Hi/)
})

test('ensureSkillFrontmatter injects name into an existing nameless block', () => {
    const out = ensureSkillFrontmatter(
        '---\nversion: 1\n---\n\n# Hi\n',
        'my-skill',
        null
    )
    assert.match(out, /^---\nname: "my-skill"\nversion: 1\n---\n/)
})

test('setFrontmatterFields replaces an existing name line', () => {
    const out = setFrontmatterFields(
        '---\nname: old\ndescription: keep\n---\n\nBody\n',
        { name: 'new-name' }
    )
    assert.match(out, /name: "new-name"/)
    assert.doesNotMatch(out, /name: old/)
    assert.match(out, /description: keep/)
})

test('computeContentHash is deterministic and file-order independent', () => {
    const files = [
        { path: 'b.md', content: 'bee' },
        { path: 'a.md', content: 'ay' }
    ]
    const reversed = [...files].reverse()
    assert.equal(
        computeContentHash('s', 'content', files),
        computeContentHash('s', 'content', reversed)
    )
    assert.notEqual(
        computeContentHash('s', 'content', files),
        computeContentHash('s', 'changed', files)
    )
    assert.notEqual(
        computeContentHash('s', 'content', files),
        computeContentHash('s2', 'content', files)
    )
})

test('shallowestSkillMdRoot picks the least-nested SKILL.md', () => {
    assert.equal(shallowestSkillMdRoot(['SKILL.md', 'a/SKILL.md']), '')
    assert.equal(
        shallowestSkillMdRoot(['my-skill/SKILL.md', 'my-skill/ref/deep.md']),
        'my-skill'
    )
    assert.equal(
        shallowestSkillMdRoot(['a/b/SKILL.md', 'z/SKILL.md']),
        'z'
    )
    assert.equal(shallowestSkillMdRoot(['readme.md']), null)
})

test('shouldIgnoreImportPath drops dotfiles, __MACOSX, licenses and nested SKILL.md', () => {
    assert.equal(shouldIgnoreImportPath('.DS_Store'), true)
    assert.equal(shouldIgnoreImportPath('ref/.hidden/file.md'), true)
    assert.equal(shouldIgnoreImportPath('__MACOSX/x.md'), true)
    assert.equal(shouldIgnoreImportPath('LICENSE'), true)
    assert.equal(shouldIgnoreImportPath('license.txt'), true)
    assert.equal(shouldIgnoreImportPath('nested/SKILL.md'), true)
    assert.equal(shouldIgnoreImportPath('references/guide.md'), false)
})

test('parseSkillArchive imports a wrapper-dir layout', () => {
    const data = zip({
        'my-skill/SKILL.md':
            '---\nname: my-skill\ndescription: does things\n---\n\n# My Skill\n',
        'my-skill/references/guide.md': 'guide body',
        'my-skill/.DS_Store': 'junk',
        '__MACOSX/my-skill/SKILL.md': 'resource fork junk'
    })
    const bundle = parseSkillArchive(data, 'my-skill.skill')
    assert.equal(bundle.name, 'my-skill')
    assert.equal(bundle.description, 'does things')
    assert.equal(bundle.files.length, 1)
    assert.equal(bundle.files[0].path, 'references/guide.md')
    assert.equal(bundle.origin.type, 'archive')
})

test('parseSkillArchive imports a root-level SKILL.md and repairs frontmatter', () => {
    const data = zip({
        'SKILL.md': '# Bare Skill\n\nNo frontmatter here.\n'
    })
    const bundle = parseSkillArchive(data, 'bare.zip')
    assert.equal(bundle.name, 'Bare Skill')
    assert.match(bundle.content, /^---\nname: "Bare Skill"/)
})

test('parseSkillArchive drops binary supporting files', () => {
    const entries = {
        'my-skill/SKILL.md': strToU8('---\nname: my-skill\n---\n'),
        'my-skill/blob.bin': new Uint8Array([0, 1, 2, 3])
    }
    const bundle = parseSkillArchive(
        Buffer.from(zipSync(entries)),
        'x.skill'
    )
    assert.equal(bundle.files.length, 0)
})

test('parseSkillArchive rejects archives without SKILL.md', () => {
    assert.throws(
        () => parseSkillArchive(zip({ 'readme.md': 'hi' }), 'x.zip'),
        BadRequestException
    )
})

test('parseSkillArchive rejects zip-slip paths', () => {
    assert.throws(
        () =>
            parseSkillArchive(
                zip({ 'SKILL.md': 'ok', '../evil.md': 'bad' }),
                'x.zip'
            ),
        BadRequestException
    )
})

test('parseSkillArchive rejects invalid zip bytes', () => {
    assert.throws(
        () => parseSkillArchive(Buffer.from('not a zip'), 'x.zip'),
        BadRequestException
    )
})

test('parseImportUrl handles repo, tree, blob, bare and github: forms', () => {
    assert.deepEqual(parseImportUrl('https://github.com/acme/skills'), {
        owner: 'acme',
        repo: 'skills',
        ref: null,
        path: '.',
        url: 'https://github.com/acme/skills'
    })
    assert.partialDeepStrictEqual(
        parseImportUrl('https://github.com/acme/skills/tree/main/skills/pdf'),
        { owner: 'acme', repo: 'skills', ref: 'main', path: 'skills/pdf' }
    )
    assert.partialDeepStrictEqual(
        parseImportUrl(
            'https://github.com/acme/skills/blob/main/skills/pdf/SKILL.md'
        ),
        { owner: 'acme', repo: 'skills', ref: 'main', path: 'skills/pdf' }
    )
    assert.partialDeepStrictEqual(parseImportUrl('acme/skills'), {
        owner: 'acme',
        repo: 'skills',
        ref: null,
        path: '.'
    })
    assert.partialDeepStrictEqual(
        parseImportUrl('github:acme/skills@main:skills/pdf'),
        { owner: 'acme', repo: 'skills', ref: 'main', path: 'skills/pdf' }
    )
})

test('parseImportUrl rejects non-github hosts and non-SKILL.md blobs', () => {
    assert.throws(
        () => parseImportUrl('https://gitlab.com/acme/skills'),
        BadRequestException
    )
    assert.throws(
        () =>
            parseImportUrl(
                'https://github.com/acme/skills/blob/main/readme.md'
            ),
        BadRequestException
    )
})

test('assertSafeLibraryFilePath enforces the reserved SKILL.md name', () => {
    assert.equal(
        assertSafeLibraryFilePath('references/guide.md'),
        'references/guide.md'
    )
    assert.equal(assertSafeLibraryFilePath('./a.md'), 'a.md')
    assert.throws(() => assertSafeLibraryFilePath('SKILL.md'))
    assert.throws(() => assertSafeLibraryFilePath('skill.MD'))
    assert.throws(() => assertSafeLibraryFilePath('../evil.md'))
    assert.throws(() => assertSafeLibraryFilePath('/abs.md'))
    assert.throws(() => assertSafeLibraryFilePath('a//b.md'))
})

test('libraryStoreKey is copy-on-write across content hashes', () => {
    const a = libraryStoreKey({
        name: 'My Skill',
        librarySkillId: 'skl_x',
        contentHash: 'aaa'
    })
    const b = libraryStoreKey({
        name: 'My Skill',
        librarySkillId: 'skl_x',
        contentHash: 'bbb'
    })
    assert.notEqual(a, b)
    assert.match(a, /^my-skill-[0-9a-f]{16}$/)
})
