import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConfigService } from '@nestjs/config'
import { AgentCreateRequestsService } from '../src/modules/agents/create-requests/agent-create-requests.service'

const serviceWithKey = (key?: string): AgentCreateRequestsService =>
    new AgentCreateRequestsService(
        {} as never,
        {
            get: () => key
        } as unknown as ConfigService
    )

const body = {
    name: 'researcher',
    framework: 'claude-code',
    claudeCodeCredentials: { apiKey: 'sk-one', baseUrl: 'https://a.test' }
}

test('a fingerprint ignores the name, key order and fields left undefined', () => {
    const service = serviceWithKey()
    const fingerprint = service.fingerprint('create', body)
    assert.equal(
        service.fingerprint('create', {
            claudeCodeCredentials: {
                baseUrl: 'https://a.test',
                apiKey: 'sk-one'
            },
            workspace: undefined,
            framework: 'claude-code',
            name: 'another name'
        }),
        fingerprint
    )
})

test('another inline key, route or runtime is another create', () => {
    const service = serviceWithKey()
    const fingerprint = service.fingerprint('create', body)
    assert.notEqual(
        service.fingerprint('create', {
            ...body,
            claudeCodeCredentials: {
                ...body.claudeCodeCredentials,
                apiKey: 'sk-two'
            }
        }),
        fingerprint
    )
    assert.notEqual(service.fingerprint('add', body), fingerprint)
    assert.notEqual(
        service.fingerprint('add', { name: 'x' }, { runtimeId: 'art_a' }),
        service.fingerprint('add', { name: 'x' }, { runtimeId: 'art_b' })
    )
})

// The stored value is a MAC under the API's key: the same request on two
// deployments hashes differently, and nothing in it can be checked against a
// guessed key without that secret.
test('a fingerprint is keyed with API_CRYPTO_KEY', () => {
    const one = serviceWithKey(Buffer.alloc(32, 1).toString('base64'))
    const two = serviceWithKey(Buffer.alloc(32, 2).toString('base64'))
    assert.notEqual(
        one.fingerprint('create', body),
        two.fingerprint('create', body)
    )
    assert.match(one.fingerprint('create', body), /^[0-9a-f]{64}$/)
    assert.doesNotMatch(one.fingerprint('create', body), /sk-one/)
})
