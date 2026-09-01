import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { CreateAgentDto } from '../src/modules/agents/dto/create-agent.dto'

const validateBody = async (
    input: Record<string, unknown>
): Promise<string[]> => {
    const dto = plainToInstance(CreateAgentDto, input)
    const errors = await validate(dto)
    return errors.flatMap((e) => Object.values(e.constraints ?? {}))
}

const base = { name: 'Sub Agent', runtime: 'sprites' }

test('CreateAgentDto accepts a bare runtime-local create for each coding framework', async () => {
    for (const framework of ['claude-code', 'codex', 'gemini-cli']) {
        const errors = await validateBody({
            ...base,
            framework,
            modelConfigSource: 'runtime-local'
        })
        assert.deepEqual(errors, [], framework)
    }
})

test('CreateAgentDto rejects runtime-local for frameworks without a model-config surface', async () => {
    const errors = await validateBody({
        ...base,
        framework: 'openclaw',
        openclawCredentials: {
            modelProvider: 'anthropic',
            apiKey: 'k'.repeat(12),
            primaryModelName: 'claude-sonnet-4-5'
        },
        modelConfigSource: 'runtime-local'
    })
    assert.equal(
        errors.some((m) => m.includes('only available for claude-code')),
        true,
        errors.join('; ')
    )
})

test('CreateAgentDto rejects runtime-local combined with credentials or saveCredentialAs', async () => {
    const withBlock = await validateBody({
        ...base,
        framework: 'claude-code',
        claudeCodeCredentials: { anthropicAuthToken: 'sk-ant-0123456789' },
        modelConfigSource: 'runtime-local'
    })
    assert.equal(
        withBlock.some((m) => m.includes('cannot be combined')),
        true,
        withBlock.join('; ')
    )

    const withSave = await validateBody({
        ...base,
        framework: 'codex',
        saveCredentialAs: { providerName: 'My Key' },
        modelConfigSource: 'runtime-local'
    })
    assert.equal(
        withSave.some((m) => m.includes('cannot be combined')),
        true,
        withSave.join('; ')
    )
})

test('CreateAgentDto keeps accepting an ordinary platform create', async () => {
    const errors = await validateBody({
        ...base,
        framework: 'claude-code',
        claudeCodeCredentials: { anthropicAuthToken: 'sk-ant-0123456789' },
        modelConfigSource: 'platform'
    })
    assert.deepEqual(errors, [])
})
