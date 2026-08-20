import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStatusBanner } from '../src/modules/terminal/status-banner'

const baseAgent = {
    id: 'agent-1',
    userId: 'u-1',
    runtimeId: 'rt-1',
    name: 'mba13a',
    framework: 'claude-code',
    runtime: 'daemon',
    status: 'running',
    spriteStatus: null,
    k8sPodPhase: null,
    accountId: null,
    clusterId: null,
    daemonId: 'dh-1',
    internalId: 'agent-1',
    model: null,
    extras: {},
    workspacePath: '/Users/cy/.nca/workspaces/agent-1',
    spriteName: null,
    spriteId: null,
    mountPath: '/workspace',
    fileRoots: [],
    namespace: null,
    ingressHost: null,
    currentPhase: null,
    failureReason: null,
    startedAt: null,
    lastBootstrappedAt: null,
    lastReconciledAt: null,
    createdAt: new Date('2026-05-07'),
    updatedAt: new Date('2026-05-07')
}

test('terminal banner shows daemon workspace instead of mountPath', () => {
    const banner = buildStatusBanner(baseAgent as never)

    assert.match(banner, / daemon {2}: dh-1/)
    assert.match(banner, / workspace: \/Users\/cy\/\.nca\/workspaces\/agent-1/)
    assert.doesNotMatch(banner, / namespace: \?/)
    assert.doesNotMatch(banner, / mountPath: \/workspace/)
})
