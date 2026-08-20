import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveInstallTarget } from '../src/commands/skills/index'

test('resolveInstallTarget: single install from resolved agent context', () => {
    assert.deepEqual(
        resolveInstallTarget({ skillId: 'sk_x', agentId: 'agt_a' }),
        { mode: 'single', skillId: 'sk_x', agentId: 'agt_a' }
    )
    assert.deepEqual(
        resolveInstallTarget({ skillId: 'sk_x', agentId: '  agt_a  ' }),
        { mode: 'single', skillId: 'sk_x', agentId: 'agt_a' }
    )
})

test('resolveInstallTarget: batch install parses and trims ids', () => {
    assert.deepEqual(
        resolveInstallTarget({
            skillId: 'sk_x',
            agentIds: ' agt_a , agt_b ,, '
        }),
        { mode: 'batch', skillId: 'sk_x', agentIds: ['agt_a', 'agt_b'] }
    )
})

test('resolveInstallTarget: explicit --agent-ids wins over ambient agent context', () => {
    assert.deepEqual(
        resolveInstallTarget({
            skillId: 'sk_x',
            agentId: 'agt_env',
            agentIds: 'agt_a,agt_b'
        }),
        { mode: 'batch', skillId: 'sk_x', agentIds: ['agt_a', 'agt_b'] }
    )
})

test('resolveInstallTarget: empty --agent-ids errors', () => {
    assert.throws(
        () => resolveInstallTarget({ skillId: 'sk_x', agentIds: ' , ' }),
        /--agent-ids is empty/
    )
})

test('resolveInstallTarget: no agent at all errors with guidance', () => {
    for (const agentId of [undefined, '', '   ']) {
        assert.throws(
            () => resolveInstallTarget({ skillId: 'sk_x', agentId }),
            /pass --agent-id \(or --agent-ids for a batch install\), or set \$MF_AGENT_ID/
        )
    }
})
