import 'tsconfig-paths/register'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@manyfold/db'
import {
    buildMeasureScript,
    parseMeasureOutput
} from '@/modules/agents/sprite-storage/sprite-storage.service'

const SEP = '__NCA_STORAGE_SEP__'

const target = {
    hostAgents: [{ id: 'agt-1' }, { id: 'agt-2' }] as Agent[],
    homes: [{ framework: 'claude-code', homeDir: '~/.claude' }]
}

test('parseMeasureOutput maps df + per-agent workspaces + homes in section order', () => {
    const stdout = [
        '9000000000',
        SEP,
        '1200000000',
        SEP,
        '300000000',
        SEP,
        '450000000'
    ].join('\n')
    const result = parseMeasureOutput(target, stdout)
    assert.equal(result.measuredVia, 'df')
    assert.equal(result.vmUsedBytes, 9_000_000_000)
    assert.deepEqual(result.workspaces, [
        { agentId: 'agt-1', bytes: 1_200_000_000 },
        { agentId: 'agt-2', bytes: 300_000_000 }
    ])
    assert.deepEqual(result.homes, [
        { framework: 'claude-code', bytes: 450_000_000 }
    ])
})

// WHY: a failing df prints nothing at all — its pipeline ends in awk, which
// exits 0 on empty input. The du readings are still usable, so the measurement
// downgrades rather than failing.
test('parseMeasureOutput falls back to du sums when the df section is empty', () => {
    const stdout = ['', SEP, '100', SEP, '200', SEP, '50'].join('\n')
    const result = parseMeasureOutput(target, stdout)
    assert.equal(result.measuredVia, 'du')
    assert.equal(result.vmUsedBytes, 350)
})

// WHY: this is the shape that used to be persisted as an authoritative 0 over
// a real reading. It must stay distinguishable from a genuinely empty VM, so
// nothing may be fabricated into workspaces/homes either.
test('parseMeasureOutput reports stale when every section is empty', () => {
    const stdout = ['', SEP, '', SEP, '', SEP, ''].join('\n')
    const result = parseMeasureOutput(target, stdout)
    assert.equal(result.measuredVia, 'stale')
    assert.equal(result.vmUsedBytes, 0)
    assert.deepEqual(result.workspaces, [])
    assert.deepEqual(result.homes, [])
})

test('parseMeasureOutput handles a bare sandbox (df only, no agents)', () => {
    const bare = { hostAgents: [] as Agent[], homes: [] }
    const result = parseMeasureOutput(bare, '7000000000')
    assert.equal(result.measuredVia, 'df')
    assert.equal(result.vmUsedBytes, 7_000_000_000)
    assert.deepEqual(result.workspaces, [])
    assert.deepEqual(result.homes, [])
})

// WHY: an omitted entry renders as "not measured" downstream; a 0 entry renders
// as an empty workspace and is subtracted from the host's "system & other"
// remainder as if it had been accounted for.
test('parseMeasureOutput omits a section that produced no number instead of recording 0', () => {
    const stdout = ['9000000000', SEP, 'du: cannot access', SEP, '42'].join('\n')
    const result = parseMeasureOutput(target, stdout)
    assert.deepEqual(result.workspaces, [{ agentId: 'agt-2', bytes: 42 }])
    assert.deepEqual(result.homes, [])
})

test('parseMeasureOutput keeps a genuine 0 du reading', () => {
    const stdout = ['9000000000', SEP, '0', SEP, '42', SEP, '0'].join('\n')
    const result = parseMeasureOutput(target, stdout)
    assert.deepEqual(result.workspaces, [
        { agentId: 'agt-1', bytes: 0 },
        { agentId: 'agt-2', bytes: 42 }
    ])
    assert.deepEqual(result.homes, [{ framework: 'claude-code', bytes: 0 }])
})

// WHY: the agent-less standalone sandbox is the case that motivated the rootfs
// target. It emits no du section, so borrowing an agent's mountPath left it
// running `df /workspace` — a path nothing on the VM creates.
test('buildMeasureScript measures the rootfs of a bare sandbox with no du sections', () => {
    const script = buildMeasureScript({
        host: {} as never,
        hostAgents: [],
        homes: []
    })
    assert.match(script, /^set \+e\ndf -B1 \/ /)
    assert.equal(script.includes(SEP), false)
    assert.equal(script.includes('du -sb'), false)
    assert.equal(script.includes('/workspace'), false)
})

// WHY: sprites.dev has no separate volume, so a workspace path and `/` measure
// the same filesystem — but only `/` is guaranteed to exist.
test('buildMeasureScript targets the rootfs even when agents carry a mountPath', () => {
    const script = buildMeasureScript({
        host: {} as never,
        hostAgents: [
            {
                id: 'agt-1',
                mountPath: '/home/sprite/.manyfold/workspaces/agt-1',
                workspacePath: '/home/sprite/.manyfold/workspaces/agt-1'
            }
        ] as Agent[],
        homes: [{ framework: 'claude-code', homeDir: '~/.claude' }]
    })
    const sections = script.split(`echo ${SEP}\n`)
    assert.equal(sections.length, 3)
    assert.match(sections[0], /^set \+e\ndf -B1 \/ /)
    assert.match(
        sections[1],
        /^du -sb '\/home\/sprite\/\.manyfold\/workspaces\/agt-1'/
    )
    assert.match(sections[2], /^du -sb ~\/\.claude/)
})

// WHY: `(df …) || echo 0` used to sit on every section and never fired — the
// pipeline's exit status is awk's, which is 0 even when df failed. Reinstating
// any such fallback would make a failure indistinguishable from a real 0.
test('buildMeasureScript emits no fallback value for a failed section', () => {
    const script = buildMeasureScript({
        host: {} as never,
        hostAgents: [{ id: 'agt-1', workspacePath: '/w' }] as Agent[],
        homes: []
    })
    assert.equal(script.includes('echo 0'), false)
})
