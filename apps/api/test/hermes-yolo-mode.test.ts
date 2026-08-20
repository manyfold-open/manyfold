import assert from 'node:assert/strict'
import test from 'node:test'
import { buildHermesEnv } from '../src/modules/agents/bootstrap/hermes-shared'
import { HermesBootstrap } from '../src/modules/agents/bootstrap/hermes'
import type { ResolvedHermesCredentials } from '../src/modules/agents/credentials/resolved-credentials'

// `hermes gateway` force-enables HERMES_EXEC_ASK, so without YOLO every exec
// blocks on an approval the OpenAI-compat chat path can never deliver and the
// agent deadlocks asking to be approved (Hermes issue #29511). Both the sprite
// and k8s service modes launch Hermes via buildHermesEnv, so YOLO must be part
// of the base env — not just the daemon ACP client.
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

test('HermesBootstrap propagates YOLO into the service env', () => {
    const bootstrap = new HermesBootstrap({} as never)
    const plan = bootstrap.plan(
        {
            agentId: 'agent-1',
            runtimeId: 'runtime-1',
            userId: 'user-1',
            namespace: 'nca',
            host: 'agent.example.org',
            image: 'hermes:latest',
            controlUiEnabled: false,
            dashboardEnabled: false
        },
        {
            primaryModelProvider: 'openrouter',
            primaryModelApiKey: 'sk-primary-model-token'
        }
    )

    assert.equal(plan.envSecretData.HERMES_YOLO_MODE, '1')
})
