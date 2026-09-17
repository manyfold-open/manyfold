import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createClient } from '../../src/client'
import { withLiveSprite } from '../live-sprite-harness'
import { runDetachProbe } from './exec-detach-probe'

const RUN_E2E = process.env.RUN_SPRITES_E2E === '1'

// A hard WSS drop must preserve a detached process; intentional SDK abort
// must kill it even when max_run_after_disconnect grants a longer window.
test(
    'detach e2e: disconnected exec survives its window, abort kills promptly',
    { timeout: 180_000 },
    async (t) => {
        if (!RUN_E2E) {
            t.skip('set RUN_SPRITES_E2E=1 to run')
            return
        }
        const token = process.env.SPRITES_TOKEN
        assert.ok(token, 'SPRITES_TOKEN is required when RUN_SPRITES_E2E=1')
        const client = createClient({ token, requestTimeoutMs: 15_000 })
        const name = `nca-probe-detach-${Date.now()}-${randomUUID().slice(0, 8)}`
        await withLiveSprite(t, client, name, (signal) =>
            runDetachProbe(client, name, signal)
        )
    }
)
