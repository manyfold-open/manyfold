import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import {
    CreateMessageDto,
    RegenerateMessageDto
} from '../src/modules/chat/dto/create-message.dto'

const validateBody = async (
    input: Record<string, unknown>
): Promise<{ dto: CreateMessageDto; errorCount: number }> => {
    const dto = plainToInstance(CreateMessageDto, input)
    const errors = await validate(dto)
    return { dto, errorCount: errors.length }
}

test('CreateMessageDto accepts a message without model override', async () => {
    const { dto, errorCount } = await validateBody({ text: 'hello' })

    assert.equal(errorCount, 0)
    assert.equal(dto.model, undefined)
})

test('CreateMessageDto accepts attachments without text', async () => {
    const { dto, errorCount } = await validateBody({
        attachments: [
            {
                path: 'chat-attachments/session/batch/photo.png',
                rootId: 'workspace',
                name: 'photo.png',
                contentType: 'image/png',
                size: 12
            }
        ]
    })

    assert.equal(errorCount, 0)
    assert.equal(dto.text, undefined)
    assert.equal(
        dto.attachments?.[0]?.path,
        'chat-attachments/session/batch/photo.png'
    )
})

test('CreateMessageDto accepts context refs without text', async () => {
    const { dto, errorCount } = await validateBody({
        contextRefs: [
            {
                path: '/home/sprite/.codex/config.toml',
                rootId: 'codex-home',
                name: 'config.toml',
                entryType: 'file',
                contentType: 'text/plain',
                size: 12
            }
        ]
    })

    assert.equal(errorCount, 0)
    assert.equal(dto.text, undefined)
    assert.equal(dto.contextRefs?.[0]?.rootId, 'codex-home')
    assert.equal(dto.contextRefs?.[0]?.entryType, 'file')
})

test('CreateMessageDto accepts text and attachments together', async () => {
    const { errorCount } = await validateBody({
        text: 'please inspect this',
        attachments: [{ path: 'chat-attachments/session/batch/log.txt' }]
    })

    assert.equal(errorCount, 0)
})

test('CreateMessageDto accepts framework model config and default persistence', async () => {
    const { dto, errorCount } = await validateBody({
        text: 'hello',
        modelConfigSource: 'platform',
        modelConfig: {
            framework: 'codex',
            model: 'gpt-5.5',
            speed: 'fast',
            intelligence: 'high'
        },
        saveAsDefault: true
    })

    assert.equal(errorCount, 0)
    assert.equal(dto.modelConfigSource, 'platform')
    assert.deepEqual(dto.modelConfig, {
        framework: 'codex',
        model: 'gpt-5.5',
        speed: 'fast',
        intelligence: 'high'
    })
    assert.equal(dto.saveAsDefault, true)
})

test('CreateMessageDto accepts runtime-local model source', async () => {
    const { dto, errorCount } = await validateBody({
        text: 'hello',
        modelConfigSource: 'runtime-local'
    })

    assert.equal(errorCount, 0)
    assert.equal(dto.modelConfigSource, 'runtime-local')
})

test('CreateMessageDto accepts codex permission mode', async () => {
    const { dto, errorCount } = await validateBody({
        text: 'hello',
        codexPermissionMode: 'full-access'
    })

    assert.equal(errorCount, 0)
    assert.equal(dto.codexPermissionMode, 'full-access')
})

test('CreateMessageDto accepts Claude Code permission mode', async () => {
    const { dto, errorCount } = await validateBody({
        text: 'hello',
        claudeCodePermissionMode: 'bypassPermissions'
    })

    assert.equal(errorCount, 0)
    assert.equal(dto.claudeCodePermissionMode, 'bypassPermissions')
})

test('CreateMessageDto rejects invalid codex permission mode', async () => {
    const { errorCount } = await validateBody({
        text: 'hello',
        codexPermissionMode: 'root'
    })

    assert.equal(errorCount, 1)
})

test('CreateMessageDto rejects invalid Claude Code permission mode', async () => {
    const { errorCount } = await validateBody({
        text: 'hello',
        claudeCodePermissionMode: 'root'
    })

    assert.equal(errorCount, 1)
})

test('CreateMessageDto rejects invalid model source', async () => {
    const { errorCount } = await validateBody({
        text: 'hello',
        modelConfigSource: 'local'
    })

    assert.equal(errorCount, 1)
})

test('CreateMessageDto rejects non-boolean saveAsDefault', async () => {
    const { errorCount } = await validateBody({
        text: 'hello',
        saveAsDefault: 'true'
    })

    assert.equal(errorCount, 1)
})

test('CreateMessageDto rejects empty payloads', async () => {
    const { errorCount } = await validateBody({ text: '   ' })

    assert.equal(errorCount, 1)
})

test('CreateMessageDto rejects too many attachments', async () => {
    const { errorCount } = await validateBody({
        attachments: Array.from({ length: 11 }, (_, index) => ({
            path: `chat-attachments/session/batch/file-${index}.txt`
        }))
    })

    assert.equal(errorCount, 1)
})

test('CreateMessageDto rejects invalid attachment paths', async () => {
    const { errorCount } = await validateBody({
        attachments: [{ path: '' }]
    })

    assert.equal(errorCount, 1)
})

test('CreateMessageDto rejects invalid context refs', async () => {
    const { errorCount } = await validateBody({
        contextRefs: [{ path: '/workspace/src', entryType: 'symlink' }]
    })

    assert.equal(errorCount, 1)
})

test('CreateMessageDto trims model override', async () => {
    const { dto, errorCount } = await validateBody({
        text: 'hello',
        model: '  opus  '
    })

    assert.equal(errorCount, 0)
    assert.equal(dto.model, 'opus')
})

test('CreateMessageDto drops empty model override', async () => {
    const { dto, errorCount } = await validateBody({
        text: 'hello',
        model: '   '
    })

    assert.equal(errorCount, 0)
    assert.equal(dto.model, undefined)
})

test('CreateMessageDto rejects overly long model override', async () => {
    const { errorCount } = await validateBody({
        text: 'hello',
        model: 'm'.repeat(256)
    })

    assert.equal(errorCount, 1)
})

test('RegenerateMessageDto accepts codex turn options without attachments', async () => {
    const dto = plainToInstance(RegenerateMessageDto, {
        text: ' edited prompt ',
        modelConfigSource: 'platform',
        modelConfig: {
            framework: 'codex',
            model: 'gpt-5.5',
            speed: 'fast',
            intelligence: 'high'
        },
        saveAsDefault: true,
        codexPermissionMode: 'auto-review'
    })
    const errors = await validate(dto)

    assert.equal(errors.length, 0)
    assert.equal(dto.text, ' edited prompt ')
    assert.equal(dto.codexPermissionMode, 'auto-review')
})

test('RegenerateMessageDto rejects invalid codex permission mode', async () => {
    const dto = plainToInstance(RegenerateMessageDto, {
        text: 'edited',
        codexPermissionMode: 'root'
    })
    const errors = await validate(dto)

    assert.equal(errors.length, 1)
})
