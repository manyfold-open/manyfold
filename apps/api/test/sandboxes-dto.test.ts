import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import {
    CreateSandboxDto,
    SetSandboxTerminalDto
} from '../src/modules/sandboxes/dto/sandbox.dto'

test('sandbox create DTO normalizes and validates display names', async () => {
    const dto = plainToInstance(CreateSandboxDto, {
        name: '  研究 sandbox  ',
        accountId: 'spa_1'
    })

    assert.deepEqual(await validate(dto), [])
    assert.equal(dto.name, '研究 sandbox')
})

test('sandbox DTOs reject invalid name, account, and terminal shapes', async () => {
    const invalidCreate = plainToInstance(CreateSandboxDto, {
        name: 'sandbox\nbad',
        accountId: ''
    })
    const invalidTerminal = plainToInstance(SetSandboxTerminalDto, {
        enabled: 'true'
    })

    assert.notEqual((await validate(invalidCreate)).length, 0)
    assert.notEqual((await validate(invalidTerminal)).length, 0)
})
