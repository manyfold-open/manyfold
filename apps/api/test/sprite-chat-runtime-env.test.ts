import test from 'node:test'
import assert from 'node:assert/strict'
import { manyfoldRuntimeEnv } from '../src/modules/chat/adapters/exec-driver-factory'

test('manyfoldRuntimeEnv injects staging API and agent identity for sprite chat exec', () => {
    const config = {
        get: (key: string) =>
            key === 'PUBLIC_API_BASE_URL'
                ? 'https://api.example.com'
                : key === 'MF_DEPLOY_ENV'
                  ? 'staging'
                  : undefined
    }

    assert.deepEqual(manyfoldRuntimeEnv(config as never, 'agt_staging'), {
        MF_AGENT_ID: 'agt_staging',
        MF_API_URL: 'https://api.example.com/api',
        MF_DEPLOY_ENV: 'staging'
    })
})

test('manyfoldRuntimeEnv still injects agent id when API URL is not configured', () => {
    assert.deepEqual(
        manyfoldRuntimeEnv({ get: () => undefined } as never, 'agt_only'),
        { MF_AGENT_ID: 'agt_only', MF_DEPLOY_ENV: 'local' }
    )
})
