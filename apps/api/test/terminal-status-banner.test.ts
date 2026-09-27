import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStatusBanner } from '../src/modules/terminal/status-banner'
import { contextOf, hostRow } from './helpers/runtime-context-fixture'

const baseAgent = {
    id: 'agent-1',
    userId: 'u-1',
    runtimeId: 'rt-1',
    name: 'mba13a',
    framework: 'claude-code',
    status: 'ready',
    internalId: 'agent-1',
    model: null,
    extras: {},
    workspacePath: '/Users/cy/.nca/workspaces/agent-1',
    spriteName: null,
    spriteId: null,
    mountPath: '/workspace',
    fileRoots: [],
    currentPhase: null,
    failureReason: null,
    startedAt: null,
    lastBootstrappedAt: null,
    lastReconciledAt: null,
    createdAt: new Date('2026-05-07'),
    updatedAt: new Date('2026-05-07')
}

test('terminal banner shows daemon workspace instead of mountPath', () => {
    const banner = buildStatusBanner(
        contextOf({
            agent: baseAgent as never,
            host: hostRow({ id: 'dh-1', userId: 'u-1', name: 'mba13a' })
        })
    )

    assert.match(banner, / host {5}: mba13a \(dh-1\)/)
    assert.match(banner, / runtime {2}: daemon/)
    assert.match(banner, / workspace: \/Users\/cy\/\.nca\/workspaces\/agent-1/)
    assert.doesNotMatch(banner, / namespace: \?/)
    assert.doesNotMatch(banner, / mountPath: \/workspace/)
})
