import assert from 'node:assert/strict'
import test from 'node:test'
import { InternalServerErrorException } from '@nestjs/common'
import {
    classifyError,
    sanitizeMessage
} from '../src/modules/agents/agents.controller'

test('classifyError preserves orchestrator errorClass from HTTP exception response', () => {
    const err = new InternalServerErrorException({
        message: 'claude --print returned is_error=true',
        errorClass: 'bootstrap:claude-verify'
    })

    assert.equal(classifyError(err), 'bootstrap:claude-verify')
})

test('sanitizeMessage reads HTTP exception response message', () => {
    const err = new InternalServerErrorException({
        message: 'claude --print returned is_error=true: failed',
        errorClass: 'bootstrap:claude-verify'
    })

    assert.equal(
        sanitizeMessage(err),
        'claude --print returned is_error=true: failed'
    )
})
