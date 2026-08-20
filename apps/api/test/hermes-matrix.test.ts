import assert from 'node:assert/strict'
import test from 'node:test'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { HermesBootstrap } from '../src/modules/agents/bootstrap/hermes'
import { CreateAgentDto } from '../src/modules/agents/dto/create-agent.dto'
import { UpdateAgentCredentialsDto } from '../src/modules/agents/dto/update-agent-credentials.dto'

const ctx = {
    agentId: 'agent-1',
    runtimeId: 'runtime-1',
    userId: 'user-1',
    namespace: 'nca',
    host: 'agent.example.org',
    image: 'hermes:latest',
    controlUiEnabled: false,
    dashboardEnabled: false
}

test('HermesBootstrap injects Matrix homeserver and access token env', () => {
    const bootstrap = new HermesBootstrap({} as never)
    const plan = bootstrap.plan(ctx, {
        primaryModelProvider: 'openrouter',
        primaryModelApiKey: 'sk-primary-model-token',
        matrixHomeserver: 'https://matrix.example.org',
        matrixAccessToken: 'matrix-access-token-123456'
    })

    assert.equal(
        plan.envSecretData.HERMES_MATRIX_HOMESERVER,
        'https://matrix.example.org'
    )
    assert.equal(
        plan.envSecretData.HERMES_MATRIX_ACCESS_TOKEN,
        'matrix-access-token-123456'
    )
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
