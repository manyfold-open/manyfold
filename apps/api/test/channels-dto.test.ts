import assert from 'node:assert/strict'
import test from 'node:test'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import {
    CreateChannelDto,
    StartLarkRegistrationDto
} from '../src/modules/channels/dto/channels.dto'

test('StartLarkRegistrationDto accepts only the fields safe for the QR flow', async () => {
    const dto = plainToInstance(StartLarkRegistrationDto, {
        agentId: ' agt_1 ',
        appRegion: 'feishu',
        label: ' Support ',
        botName: ' Support Bot '
    })

    assert.deepEqual(await validate(dto), [])
    assert.equal(dto.agentId, 'agt_1')
    assert.equal(dto.label, 'Support')
    assert.equal(dto.botName, 'Support Bot')
})

test('StartLarkRegistrationDto rejects unknown regions and overlong bot names', async () => {
    const dto = plainToInstance(StartLarkRegistrationDto, {
        agentId: 'agt_1',
        appRegion: 'mars',
        label: 'Support',
        botName: 'x'.repeat(61)
    })

    const errors = await validate(dto)
    assert.deepEqual(
        errors.map((error) => error.property).sort(),
        ['appRegion', 'botName']
    )
})

test('CreateChannelDto accepts discord provider', async () => {
    const dto = plainToInstance(CreateChannelDto, {
        agentId: 'agent-1',
        provider: 'discord',
        label: 'Discord',
        config: {
            allowedGuildIds: [],
            mentionOnly: true,
            shareSessionInChannel: false,
            threadIsolation: true,
            progressMode: 'preview'
        },
        credentials: {
            botToken: 'a'.repeat(60)
        }
    })

    const errors = await validate(dto)

    assert.deepEqual(errors, [])
})

test('CreateChannelDto accepts weixin provider', async () => {
    const dto = plainToInstance(CreateChannelDto, {
        agentId: 'agent-1',
        provider: 'weixin',
        label: 'WeChat',
        config: {
            allowedUserIds: [],
            operatorUserIds: [],
            progressMode: 'final'
        },
        credentials: {
            botToken: 'weixin-bot-token-123456',
            baseUrl: null
        }
    })

    const errors = await validate(dto)

    assert.deepEqual(errors, [])
})

test('CreateChannelDto accepts matrix provider', async () => {
    const dto = plainToInstance(CreateChannelDto, {
        agentId: 'agent-1',
        provider: 'matrix',
        label: 'Matrix',
        config: {
            homeserver: 'https://matrix.example.org',
            allowedRoomIds: [],
            allowedUserIds: [],
            freeResponseRoomIds: [],
            autoJoin: true,
            mentionOnly: true,
            shareSessionInChannel: false,
            threadIsolation: true,
            autoThread: true,
            progressMode: 'preview'
        },
        credentials: {
            accessToken: 'matrix-access-token-123456'
        }
    })

    const errors = await validate(dto)

    assert.deepEqual(errors, [])
})
