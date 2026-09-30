import test from 'node:test'
import assert from 'node:assert/strict'
import { CommanderError } from 'commander'
import { json, runMf, type Route, type Run } from './fixtures/fake-api'

// `mf skills install <skill>`: a skill by its id, or by its name, looked for
// in the library and the catalog; and what `mf skills discover` says when it
// has nothing to list yet.

const catalogSkill = (
    name: string,
    over: Record<string, unknown> = {}
): Record<string, unknown> => ({
    skillId: `github:anthropics/skills@main:skills/${name}`,
    name,
    description: `${name} skill`,
    repoOwner: 'anthropics',
    repoName: 'skills',
    repoBranch: 'main',
    sourcePath: `skills/${name}`,
    ...over
})

const installed = (skillId: string) => ({
    id: 'usk_1',
    skillId,
    name: 'mcp-builder',
    enabled: true,
    materializeStatus: 'installed'
})

const routes = (
    pages: Array<Record<string, unknown>>,
    library: Array<Record<string, unknown>> = [],
    over: Record<string, Route> = {}
): Record<string, Route> => ({
    'GET /skills/library': () => json(library),
    'GET /skills/discover': (_call, index) =>
        json(pages[Math.min(index, pages.length - 1)]),
    'POST /skills/install': (call) =>
        json(installed((call.body as { skillId: string }).skillId), 201),
    ...over
})

const installs = (run: Run) =>
    run.calls.filter(
        (call) => call.method === 'POST' && call.path === '/skills/install'
    )

const install = (...args: string[]) => [
    'skills',
    'install',
    ...args,
    '--agent-id',
    'agt_1'
]

test('a name finds its one skill, and installs it by its id', async () => {
    const run = await runMf(
        install('mcp-builder'),
        routes([
            {
                items: [
                    catalogSkill('mcp-builder-extras'),
                    catalogSkill('mcp-builder')
                ],
                nextCursor: null
            }
        ])
    )
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(
        installs(run).map((call) => call.body),
        [
            {
                skillId: 'github:anthropics/skills@main:skills/mcp-builder',
                agentId: 'agt_1'
            }
        ]
    )
    const search = run.calls.find((call) => call.path === '/skills/discover')
    assert.equal(search?.query.get('q'), 'mcp-builder')
    assert.deepEqual(run.out, [
        'usk_1  mcp-builder  enabled  installed  from anthropics/skills'
    ])
})

test('a name is matched case-blind, by a skill folder too, across pages', async () => {
    const run = await runMf(
        install('PDF-Toolkit'),
        routes([
            { items: [catalogSkill('other')], nextCursor: '100' },
            {
                items: [
                    catalogSkill('PDF Toolkit', {
                        skillId: 'github:acme/tools@main:skills/pdf-toolkit',
                        repoOwner: 'acme',
                        repoName: 'tools',
                        sourcePath: 'skills/pdf-toolkit'
                    })
                ],
                nextCursor: null
            }
        ])
    )
    assert.equal(run.error, undefined, String(run.error))
    assert.equal(
        (installs(run)[0]?.body as { skillId: string }).skillId,
        'github:acme/tools@main:skills/pdf-toolkit'
    )
    const pages = run.calls.filter((call) => call.path === '/skills/discover')
    assert.deepEqual(
        pages.map((call) => call.query.get('cursor')),
        [null, '100']
    )
})

test('a name several skills share lists them, and installs none', async () => {
    const run = await runMf(
        install('pdf'),
        routes(
            [
                {
                    items: [
                        catalogSkill('pdf'),
                        catalogSkill('pdf', {
                            skillId: 'github:acme/tools@main:skills/pdf',
                            repoOwner: 'acme',
                            repoName: 'tools'
                        })
                    ],
                    nextCursor: null
                }
            ],
            [{ id: 'skl_mine', name: 'pdf' }]
        )
    )
    assert.ok(run.error instanceof CommanderError, String(run.error))
    assert.match(run.error.message, /3 skills are named "pdf"/)
    assert.match(run.error.message, /skl_mine {2}your library/)
    assert.match(
        run.error.message,
        /acme\/pdf {2}github:acme\/tools@main:skills\/pdf/
    )
    assert.match(
        run.error.message,
        /anthropics\/pdf {2}github:anthropics\/skills@main:skills\/pdf/
    )
    assert.deepEqual(installs(run), [])
})

test("<owner>/<name> picks one repo owner's skill of that name", async () => {
    const page = {
        items: [
            catalogSkill('pdf'),
            catalogSkill('pdf', {
                skillId: 'github:acme/tools@main:skills/pdf',
                repoOwner: 'acme',
                repoName: 'tools'
            })
        ],
        nextCursor: null
    }
    const run = await runMf(install('Acme/pdf'), routes([page]))
    assert.equal(run.error, undefined, String(run.error))
    assert.equal(
        (installs(run)[0]?.body as { skillId: string }).skillId,
        'github:acme/tools@main:skills/pdf'
    )
    // Only the catalog has owners; the library is not asked.
    assert.equal(
        run.calls.some((call) => call.path === '/skills/library'),
        false
    )
    assert.equal(
        run.calls
            .find((call) => call.path === '/skills/discover')
            ?.query.get('q'),
        'pdf'
    )
    const none = await runMf(install('nobody/pdf'), routes([page]))
    assert.match(
        String(none.error),
        /no skill named "nobody\/pdf" in the catalog/
    )
})

test('a name nothing has says where to look; an id is taken as given', async () => {
    const none = await runMf(
        install('nothing-like-it'),
        routes([{ items: [], nextCursor: null }])
    )
    assert.match(
        String(none.error),
        /no skill named "nothing-like-it" in your library or the catalog/
    )
    assert.deepEqual(installs(none), [])

    const byId = await runMf(
        install('skl_agqpcvns3zy2lptuyfdtzwaz7i'),
        routes([{ items: [], nextCursor: null }])
    )
    assert.equal(byId.error, undefined, String(byId.error))
    assert.equal(
        byId.calls.some((call) => call.path === '/skills/discover'),
        false
    )
    assert.deepEqual(
        installs(byId).map(
            (call) => (call.body as { skillId: string }).skillId
        ),
        ['skl_agqpcvns3zy2lptuyfdtzwaz7i']
    )

    const flag = await runMf(
        [
            'skills',
            'install',
            '--skill-id',
            'github:anthropics/skills@main:skills/pdf',
            '--agent-id',
            'agt_1'
        ],
        routes([])
    )
    assert.equal(flag.error, undefined, String(flag.error))
    assert.equal(installs(flag).length, 1)
})

test('the skill is named once: as the argument or as --skill-id', async () => {
    const both = await runMf(
        [...install('pdf'), '--skill-id', 'skl_x'],
        routes([])
    )
    assert.ok(both.error instanceof CommanderError)
    assert.match(both.error.message, /name the skill once/)
    const neither = await runMf(install(), routes([]))
    assert.ok(neither.error instanceof CommanderError)
    assert.match(neither.error.message, /which skill: pass its name or its id/)
    assert.deepEqual([...both.calls, ...neither.calls], [])
})

test('discover says when it has nothing to list, and which repos it is still reading', async () => {
    const empty = await runMf(
        ['skills', 'discover'],
        routes([{ items: [], nextCursor: null }])
    )
    assert.deepEqual(empty.out, ['(no skills found)'])

    const reading = await runMf(
        ['skills', 'discover'],
        routes([
            {
                items: [catalogSkill('mcp-builder')],
                nextCursor: null,
                pendingRepos: [
                    {
                        id: 'builtin:ComposioHQ/awesome-claude-skills@master',
                        owner: 'ComposioHQ',
                        name: 'awesome-claude-skills',
                        branch: 'master'
                    }
                ]
            }
        ])
    )
    assert.equal(reading.out.length, 1)
    assert.deepEqual(reading.err, [
        'still reading ComposioHQ/awesome-claude-skills: their skills are not listed yet; run this again in a minute'
    ])
})

test('mf skills list and ls list the installed skills', async () => {
    for (const alias of ['list', 'ls']) {
        const run = await runMf(['skills', alias, '--agent-id', 'agt_1'], {
            'GET /skills/installed': () => json([])
        })
        assert.equal(run.error, undefined, String(run.error))
        assert.deepEqual(run.out, ['(no installed skills)'])
    }
})
