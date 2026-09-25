import assert from 'node:assert/strict'
import test from 'node:test'
import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { buildHermesEnv } from '../src/modules/agents/bootstrap/hermes-shared'
import type { ResolvedHermesCredentials } from '../src/modules/agents/credentials/resolved-credentials'
import { CreateAgentDto } from '../src/modules/agents/dto/create-agent.dto'
import { UpdateAgentCredentialsDto } from '../src/modules/agents/dto/update-agent-credentials.dto'

test('buildHermesEnv injects Matrix homeserver and access token env', () => {
    const env = buildHermesEnv({
        creds: {
            primaryModelProvider: 'openrouter',
            primaryModelApiKey: 'sk-primary-model-token',
            matrixHomeserver: 'https://matrix.example.org',
            matrixAccessToken: 'matrix-access-token-123456'
        } as ResolvedHermesCredentials,
        apiServerKey: 'api-server-key',
        dashboardEnabled: false
    })

    assert.equal(env.HERMES_MATRIX_HOMESERVER, 'https://matrix.example.org')
    assert.equal(env.HERMES_MATRIX_ACCESS_TOKEN, 'matrix-access-token-123456')
})

test('Hermes create DTO rejects partial Matrix credentials', async () => {
    const dto = plainToInstance(CreateAgentDto, {
        name: 'Hermes Matrix',
        framework: 'hermes',
        runtime: 'k8s',
        hermesCredentials: {
            primaryModelProvider: 'openrouter',
            primaryModelApiKey: 'sk-primary-model-token',
            matrixAccessToken: 'matrix-access-token-123456'
        }
    })

    const errors = await validate(dto)

    assert.match(JSON.stringify(errors), /must be provided together/)
})

test('Hermes update DTO rejects partial Matrix credentials', async () => {
    const dto = plainToInstance(UpdateAgentCredentialsDto, {
        hermesCredentials: {
            matrixHomeserver: 'https://matrix.example.org'
        }
    })

    const errors = await validate(dto)

    assert.match(JSON.stringify(errors), /must be provided together/)
})

test('Hermes DTO accepts complete Matrix credentials', async () => {
    const createDto = plainToInstance(CreateAgentDto, {
        name: 'Hermes Matrix',
        framework: 'hermes',
        runtime: 'k8s',
        hermesCredentials: {
            primaryModelProvider: 'openrouter',
            primaryModelApiKey: 'sk-primary-model-token',
            matrixHomeserver: 'https://matrix.example.org',
            matrixAccessToken: 'matrix-access-token-123456'
        }
    })
    const updateDto = plainToInstance(UpdateAgentCredentialsDto, {
        hermesCredentials: {
            matrixHomeserver: 'https://matrix.example.org',
            matrixAccessToken: 'matrix-access-token-123456'
        }
    })

    assert.deepEqual(await validate(createDto), [])
    assert.deepEqual(await validate(updateDto), [])
})
