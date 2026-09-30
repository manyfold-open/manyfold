import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentRuntimeSummary, SandboxSummary } from '@manyfold/shared'
import {
    sandboxInstallOptions,
    sandboxItemUpdate,
    sandboxRuntimeItems,
    sandboxVersionChange,
    versionChoices
} from '../src/lib/sandboxRuntimes'
import {
    buildUpdateRows,
    emptyUpdateCenterInputs
} from '../src/lib/updateCenter'

const sandbox = (over: Partial<SandboxSummary> = {}): SandboxSummary =>
    ({
        id: 'sbx_1',
        name: 'sandbox-001',
        status: 'ready',
        detectedFrameworks: [],
        cliUpdateAvailable: false,
        herdrUpdateAvailable: false,
        ...over
    }) as SandboxSummary

const runtime = (over: Partial<AgentRuntimeSummary>): AgentRuntimeSummary =>
    ({
        id: 'art_pi',
        framework: 'pi',
        frameworkVersion: '0.87.1',
        kind: 'sprites',
        status: 'ready',
        hostId: 'sbx_1',
        agentsCount: 1,
        ...over
    }) as AgentRuntimeSummary

const detected = (framework: string, version: string | null) =>
    ({ framework, version, path: '~/.local/bin/x' }) as never

test('a sandbox lists every framework on it, claimed or not, in one order', () => {
    const items = sandboxRuntimeItems(
        sandbox({
            detectedFrameworks: [
                // the daemon's report is the CLI's own `--version` line
                detected('codex', 'codex-cli 0.151.0'),
                detected('antigravity-cli', '1.2.0')
            ]
        }),
        [runtime({})]
    )
    assert.deepEqual(
        items.map((item) => [
            item.framework,
            item.runtime?.id ?? null,
            item.version,
            item.agentsCount
        ]),
        // the image's three whether reported or not, the runtime, and
        // whatever else the daemon found, in the registry's order
        [
            ['claude-code', null, null, 0],
            ['codex', null, '0.151.0', 0],
            ['gemini-cli', null, null, 0],
            ['pi', 'art_pi', '0.87.1', 1],
            ['antigravity-cli', null, '1.2.0', 0]
        ]
    )
    assert.equal(items[3].updateId, 'framework:art_pi')
    assert.equal(
        items.find((item) => item.framework === 'codex')?.updateId,
        'framework:host:sbx_1:codex'
    )
})

test('a claimed CLI is listed once, as its runtime', () => {
    const items = sandboxRuntimeItems(
        sandbox({ detectedFrameworks: [detected('claude-code', '2.1.251')] }),
        [runtime({ id: 'art_cc', framework: 'claude-code', agentsCount: 2 })]
    )
    const claude = items.filter((item) => item.framework === 'claude-code')
    assert.equal(claude.length, 1)
    assert.equal(claude[0].runtime?.id, 'art_cc')
})

test('a sandbox that is not ready lists only its runtimes and offers nothing', () => {
    const provisioning = sandbox({ status: 'provisioning' })
    assert.deepEqual(
        sandboxRuntimeItems(provisioning, []).map((item) => item.framework),
        []
    )
    assert.deepEqual(sandboxInstallOptions(provisioning, []), [])
})

test('"+" offers what the sandbox lacks, one service framework at most', () => {
    const free = sandboxInstallOptions(sandbox(), [runtime({})])
    const offered = free.map((option) => option.framework)
    assert.ok(!offered.includes('pi'), 'already a runtime')
    assert.ok(!offered.includes('claude-code'), 'already on the sandbox')
    assert.ok(offered.includes('openclaw'))
    assert.ok(free.every((option) => option.blockedBy === null))

    const taken = sandboxInstallOptions(sandbox(), [
        runtime({ id: 'art_oc', framework: 'openclaw', agentsCount: 0 })
    ])
    const hermes = taken.find((option) => option.framework === 'hermes')
    assert.equal(hermes?.blockedBy, 'openclaw')
    assert.equal(
        taken.find((option) => option.framework === 'antigravity-cli')
            ?.blockedBy,
        null,
        'a coding CLI does not need the public port'
    )
})

test('a version moves through the runtime, else the sandbox, else not from here', () => {
    const itemFor = (
        framework: string,
        runtimes: AgentRuntimeSummary[],
        box: SandboxSummary = sandbox()
    ) =>
        sandboxRuntimeItems(box, runtimes).find(
            (item) => item.framework === framework
        )!
    const box = sandbox({
        detectedFrameworks: [detected('antigravity-cli', '1.2.0')]
    })
    assert.equal(
        sandboxVersionChange(itemFor('pi', [runtime({})], box))?.via,
        'runtime'
    )
    assert.deepEqual(sandboxVersionChange(itemFor('claude-code', [], box)), {
        via: 'sandbox'
    })
    assert.equal(
        sandboxVersionChange(itemFor('antigravity-cli', [], box)),
        null
    )
    // A runtime with no agent on it is still the handle for its install.
    assert.deepEqual(
        sandboxVersionChange(
            itemFor('codex', [
                runtime({ id: 'art_codex', framework: 'codex', agentsCount: 0 })
            ])
        ),
        { via: 'runtime', runtimeId: 'art_codex', mode: 'npm' }
    )
    assert.equal(
        sandboxVersionChange(
            itemFor('pi', [runtime({ status: 'installing' })])
        ),
        null
    )
})

// The arrow on a row leads to the Update Center, so it only shows where the
// Update Center has that very row.
test("an item's update arrow matches a row the Update Center lists", () => {
    const box = sandbox({
        detectedFrameworks: [
            detected('claude-code', '2.1.251 (Claude Code)'),
            detected('antigravity-cli', '1.2.0')
        ]
    })
    const items = sandboxRuntimeItems(box, [])
    const catalog = [
        {
            framework: 'claude-code',
            latest: '2.1.283',
            versions: ['2.1.283', '2.1.251'],
            source: 'npm',
            sourceRepo: null,
            fetchedAt: null,
            blocked: []
        },
        {
            framework: 'antigravity-cli',
            latest: '1.3.0',
            versions: ['1.3.0'],
            source: 'npm',
            sourceRepo: null,
            fetchedAt: null,
            blocked: []
        }
    ] as never
    const rows = buildUpdateRows(
        {
            ...emptyUpdateCenterInputs,
            sandboxes: [box],
            frameworkCatalog: catalog
        },
        (framework) => framework
    )
    const claude = items.find((item) => item.framework === 'claude-code')!
    const agy = items.find((item) => item.framework === 'antigravity-cli')!
    assert.equal(sandboxItemUpdate(claude, '2.1.283'), '2.1.283')
    assert.ok(rows.some((row) => row.id === claude.updateId))
    assert.equal(sandboxItemUpdate(agy, '1.3.0'), null)
    assert.ok(!rows.some((row) => row.id === agy.updateId))
    const gemini = items.find((item) => item.framework === 'gemini-cli')!
    assert.equal(sandboxItemUpdate(gemini, '1.0.0'), null, 'version unknown')
})

test('the version list puts the latest first even when the catalog omits it', () => {
    assert.deepEqual(versionChoices(['2.1.251', '2.1.270'], '2.1.283'), [
        '2.1.283',
        '2.1.270',
        '2.1.251'
    ])
    assert.deepEqual(versionChoices(['1.0.0', '1.0.0'], null), ['1.0.0'])
})
