import assert from 'node:assert/strict'
import test from 'node:test'
import { buildHermesEnv } from '../src/modules/agents/bootstrap/hermes-shared'
import type { ResolvedHermesCredentials } from '../src/modules/agents/credentials/resolved-credentials'

// `hermes gateway` force-enables HERMES_EXEC_ASK, so without YOLO every exec
// blocks on an approval the OpenAI-compat chat path can never deliver and the
// agent deadlocks asking to be approved (Hermes issue #29511). The service
// launches Hermes via buildHermesEnv, so YOLO must be part of the base env —
// not just the daemon ACP client.
const creds = {
    profile: 'default',
    primaryModelProvider: 'openrouter',
    primaryModelApiKey: 'sk-primary-model-token'
} as ResolvedHermesCredentials

test('buildHermesEnv launches the gateway with approvals bypassed', () => {
    const env = buildHermesEnv({
        creds,
        apiServerKey: 'api-server-key',
        dashboardEnabled: false
    })

    assert.equal(env.HERMES_YOLO_MODE, '1')
})
