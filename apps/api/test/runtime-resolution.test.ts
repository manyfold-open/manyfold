import { agentRuntime } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveRuntime } from '../src/modules/agents/orchestration/agent-orchestrator.service'

test('resolveRuntime uses configured admin defaults for configurable service frameworks', () => {
    assert.equal(
        resolveRuntime('openclaw', undefined, {
            defaults: { hermes: 'sprites', openclaw: 'k8s' }
        }),
        agentRuntime.K8S
    )
})

test('resolveRuntime fails when configurable service framework default is missing', () => {
    assert.throws(
        () => resolveRuntime('hermes', undefined, { defaults: {} } as never),
        /requires an explicit runtime or configured admin default/
    )
})

test('resolveRuntime keeps explicit platform defaults for coding frameworks', () => {
    assert.equal(resolveRuntime('codex'), agentRuntime.SPRITES)
})

test('resolveRuntime still lets caller-explicit runtime win', () => {
    assert.equal(
        resolveRuntime(
            'hermes',
            agentRuntime.SPRITES,
            { defaults: { hermes: 'k8s', openclaw: 'k8s' } },
            { overrides: { hermes: 'k8s' } }
        ),
        agentRuntime.SPRITES
    )
})
