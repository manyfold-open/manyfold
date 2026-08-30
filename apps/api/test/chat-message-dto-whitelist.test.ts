import type {
    AnswerPermissionRequest,
    CreateMessageRequest
} from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ValidationPipe } from '@nestjs/common'
import { CreateMessageDto } from '../src/modules/chat/dto/create-message.dto'
import { AnswerPermissionDto } from '../src/modules/chat/dto/answer-permission.dto'

// Same guard as admin-settings-dto-whitelist: the global
// `ValidationPipe({ whitelist: true, transform: true })` STRIPS every body
// property the DTO class does not declare, and `implements <Body>` cannot
// catch an omitted OPTIONAL property. `Required<CreateMessageRequest>` makes
// this a standing guard: adding a field to the shared body type stops this
// object compiling until it is listed here, where the assertion also proves
// it survives the pipe. (This is how a permission-mode field silently doing
// nothing in production would look: 200 OK, field gone.)
const FULL_BODY: Required<Omit<CreateMessageRequest, 'sessionId'>> = {
    text: 'hello',
    model: 'z-ai/glm-5.1',
    modelConfigSource: 'platform',
    modelConfig: {
        framework: 'claude-code',
        model: 'sonnet',
        effort: 'high',
        modelMap: { sonnet: 'anthropic/claude-sonnet-x' }
    },
    saveAsDefault: true,
    claudeCodePermissionMode: 'acceptEdits',
    codexPermissionMode: 'auto-review',
    hermesPermissionMode: 'acceptEdits',
    attachments: [{ path: '/w/a.txt', rootId: 'workspace', name: 'a.txt' }],
    contextRefs: [
        {
            path: '/w/b.txt',
            rootId: 'workspace',
            name: 'b.txt',
            entryType: 'file'
        }
    ],
    uploads: [{ uploadId: 'up-1' }]
}

const throughPipe = async (
    body: unknown,
    metatype: new () => object
): Promise<Record<string, unknown>> =>
    (await new ValidationPipe({
        whitelist: true,
        transform: true
    }).transform(body, {
        type: 'body',
        metatype
    })) as Record<string, unknown>

// JSON round-trip: nested @Type() transforms produce class instances with
// explicit undefined members, which are equal in substance but not to
// deepEqual. Stripping is what this guard is about, and stripping survives
// the normalization.
const normalized = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value)) as unknown

test('every create-message field survives the global whitelist pipe', async () => {
    const received = await throughPipe(FULL_BODY, CreateMessageDto)
    for (const key of Object.keys(FULL_BODY))
        assert.deepEqual(
            normalized(received[key]),
            normalized(FULL_BODY[key as keyof typeof FULL_BODY]),
            `${key} did not survive the whitelist pipe — declare it on CreateMessageDto`
        )
})

test('the permission answer body survives the pipe', async () => {
    const body: Required<AnswerPermissionRequest> = { optionId: 'allow_once' }
    const received = await throughPipe(body, AnswerPermissionDto)
    assert.equal(received.optionId, 'allow_once')
})
