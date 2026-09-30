import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommanderError } from 'commander'
import { strFromU8, unzipSync } from 'fflate'
import { json, runMf, type Route, type Run } from './fixtures/fake-api'
import { frontmatterName, packSkillDir } from '../src/commands/skills/pack'
import { UsageError } from '../src/usage-error'

// A skill written on this machine, into the library in one step: its folder
// packed as the archive the API imports, its name read off its SKILL.md.

const SKILL_MD = [
    '---',
    'name: code-summarizer',
    'description: Summarize a codebase',
    '---',
    '# Code Summarizer',
    ''
].join('\n')

const skillFolder = async (t: {
    after: (fn: () => Promise<void>) => void
}): Promise<string> => {
    const base = await mkdtemp(join(tmpdir(), 'mf-skill-folder-'))
    t.after(() => rm(base, { recursive: true, force: true }))
    const dir = join(base, 'code-summarizer')
    await mkdir(join(dir, 'references'), { recursive: true })
    await mkdir(join(dir, '.git'), { recursive: true })
    await mkdir(join(dir, 'other'), { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), SKILL_MD)
    await writeFile(join(dir, 'references', 'guide.md'), '# Guide\n')
    await writeFile(join(dir, 'scripts.sh'), 'echo hi\n')
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: main\n')
    await writeFile(join(dir, '.DS_Store'), 'x')
    await writeFile(join(dir, 'LICENSE'), 'MIT\n')
    await writeFile(join(dir, 'other', 'SKILL.md'), 'another skill\n')
    await writeFile(join(dir, 'big.log'), Buffer.alloc(1024 * 1024 + 1))
    return dir
}

test('a folder packs as the archive an import reads, leaving out what it would', async (t) => {
    const dir = await skillFolder(t)
    const packed = await packSkillDir(dir)
    const files = unzipSync(packed.archive)
    assert.deepEqual(Object.keys(files).sort(), [
        'SKILL.md',
        'references/guide.md',
        'scripts.sh'
    ])
    assert.equal(strFromU8(files['SKILL.md']), SKILL_MD)
    assert.equal(packed.filename, 'code-summarizer.skill')
    assert.equal(packed.files, 3)
    assert.deepEqual(packed.tooLarge, ['big.log'])

    const empty = await mkdtemp(join(tmpdir(), 'mf-skill-empty-'))
    t.after(() => rm(empty, { recursive: true, force: true }))
    await assert.rejects(packSkillDir(empty), (err: unknown) => {
        assert.ok(err instanceof UsageError)
        assert.match(err.message, /has no SKILL\.md at its top/)
        return true
    })
})

test('the frontmatter names a skill, quoted or not', () => {
    assert.equal(frontmatterName(SKILL_MD), 'code-summarizer')
    assert.equal(
        frontmatterName('---\nname: "quoted name"\n---\nbody'),
        'quoted name'
    )
    assert.equal(frontmatterName('# No frontmatter\nname: not this'), undefined)
    assert.equal(frontmatterName('---\ndescription: none\n---\n'), undefined)
})

const librarySkill = (over: Record<string, unknown> = {}) => ({
    id: 'skl_1',
    name: 'code-summarizer',
    description: 'Summarize a codebase',
    fileCount: 1,
    installedAgentCount: 1,
    ...over
})

const posts = (run: Run, path: string) =>
    run.calls.filter((call) => call.method === 'POST' && call.path === path)

test('library create takes the name from the content when --name is left out', async (t) => {
    const dir = await skillFolder(t)
    const create = (...args: string[]) =>
        runMf(['skills', 'library', 'create', ...args], {
            'POST /skills/library': (call) =>
                json(librarySkill(call.body as Record<string, unknown>), 201)
        })
    const named = await create('--content-file', join(dir, 'SKILL.md'))
    assert.equal(named.error, undefined, String(named.error))
    assert.equal(
        (posts(named, '/skills/library')[0]?.body as { name: string }).name,
        'code-summarizer'
    )
    const overridden = await create(
        '--name',
        'summarizer',
        '--content-file',
        join(dir, 'SKILL.md')
    )
    assert.equal(
        (posts(overridden, '/skills/library')[0]?.body as { name: string })
            .name,
        'summarizer'
    )
    const unnamed = await create('--content', '# Just a body')
    assert.ok(unnamed.error instanceof CommanderError)
    assert.match(unnamed.error.message, /name the skill: --name/)
    assert.deepEqual(unnamed.calls, [])
})

const archiveRoutes = (
    status: 'created' | 'updated',
    over: Record<string, Route> = {}
): Record<string, Route> => ({
    'POST /skills/library/import/archive': () =>
        json({ status, skill: librarySkill() }, 201),
    'POST /skills/library/skl_1/push': () =>
        json({
            results: [
                { agentId: 'agt_1', status: 'pushed' },
                { agentId: 'agt_2', status: 'failed', error: 'sandbox asleep' }
            ]
        }),
    ...over
})

test('library import --file takes a folder, packed, and says what it takes', async (t) => {
    const dir = await skillFolder(t)
    const run = await runMf(
        ['skills', 'library', 'import', '--file', dir],
        archiveRoutes('created')
    )
    assert.equal(run.error, undefined, String(run.error))
    const [upload] = posts(run, '/skills/library/import/archive')
    const body = (upload?.body as Buffer).toString('latin1')
    assert.match(body, /filename="code-summarizer\.skill"/)
    assert.ok(body.includes('PK\u0003\u0004'), 'the upload is a zip')
    assert.deepEqual(run.out, ['created  skl_1  code-summarizer'])
    assert.deepEqual(run.err, [
        "left out big.log: a skill's files are 1 MiB at most"
    ])

    const markdown = await runMf(
        ['skills', 'library', 'import', '--file', join(dir, 'SKILL.md')],
        archiveRoutes('created')
    )
    assert.ok(markdown.error instanceof CommanderError)
    assert.match(
        markdown.error.message,
        /--file takes a skill folder or a \.skill\/\.zip archive/
    )
    const missing = await runMf(
        ['skills', 'library', 'import', '--file', join(dir, 'nope')],
        archiveRoutes('created')
    )
    assert.match(String(missing.error), /does not exist/)
    assert.deepEqual([...markdown.calls, ...missing.calls], [])
})

test('library publish creates the skill, or updates it and pushes it to its agents', async (t) => {
    const dir = await skillFolder(t)
    const updated = await runMf(
        ['skills', 'library', 'publish', dir],
        archiveRoutes('updated')
    )
    assert.equal(updated.error, undefined, String(updated.error))
    const upload = posts(updated, '/skills/library/import/archive')[0]
    assert.equal(upload?.query.get('onConflict'), 'overwrite')
    assert.equal(posts(updated, '/skills/library/skl_1/push').length, 1)
    assert.deepEqual(updated.out, [
        'updated  skl_1  code-summarizer  3 files',
        '  agt_1  pushed',
        '  agt_2  failed  sandbox asleep'
    ])

    const created = await runMf(
        ['skills', 'library', 'publish', dir],
        archiveRoutes('created')
    )
    assert.equal(posts(created, '/skills/library/skl_1/push').length, 0)
    assert.deepEqual(created.out, ['created  skl_1  code-summarizer  3 files'])
    assert.match(
        created.err.at(-1) ?? '',
        /on no agent yet; install it with mf skills install code-summarizer/
    )
})

test('a delete the agents holding the skill refuse names them and --force', async () => {
    const refusal = () =>
        json(
            {
                error: {
                    code: 'skill_installed',
                    message:
                        'skill "code-summarizer" is installed on 2 agent(s); pass force=true to uninstall and delete',
                    details: { installedAgentIds: ['agt_1', 'agt_2'] }
                }
            },
            409
        )
    const human = await runMf(
        ['skills', 'library', 'delete', 'skl_1', '--yes'],
        { 'DELETE /skills/library/skl_1': refusal }
    )
    assert.equal(human.exitCode, 1)
    assert.deepEqual(human.err, [
        'skl_1 is installed on 2 agents: agt_1, agt_2',
        'Pass --force to uninstall it from those agents and delete it, or uninstall it there first.'
    ])
    const scripted = await runMf(
        ['skills', 'library', 'delete', 'skl_1', '--yes', '--json'],
        { 'DELETE /skills/library/skl_1': refusal }
    )
    const { error } = JSON.parse(scripted.err.join('\n')) as {
        error: { code: string; hint: string }
    }
    assert.equal(error.code, 'skill_installed')
    assert.match(error.hint, /--force/)
})

test('counts read as English: 1 file, 1 agent, 1 time', async () => {
    const list = await runMf(['skills', 'library', 'list'], {
        'GET /skills/library': () =>
            json([
                librarySkill(),
                librarySkill({
                    id: 'skl_2',
                    fileCount: 3,
                    installedAgentCount: 0
                })
            ])
    })
    assert.deepEqual(list.out, [
        'skl_1  code-summarizer  1 file, on 1 agent',
        'skl_2  code-summarizer  3 files, on 0 agents'
    ])
    const id = 'skl_agqpcvns3zy2lptuyfdtzwaz7i'
    const share = await runMf(['skills', 'library', 'share', id], {
        [`POST /skills/library/${id}/share`]: () =>
            json({
                id: 'lss_1',
                url: 'https://app.test/skills/shared/lss_1',
                importCount: 1
            })
    })
    assert.equal(share.error, undefined, String(share.error))
    assert.match(share.out.join('\n'), /imported 1 time;/)
})
