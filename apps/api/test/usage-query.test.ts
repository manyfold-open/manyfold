import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import {
    buildUserQuery,
    parseCursor,
    parseInstant,
    parseLimit
} from '../src/modules/usage/usage-query'

const refused = (run: () => unknown, message: RegExp): void =>
    assert.throws(
        run,
        (error: unknown) =>
            error instanceof BadRequestException && message.test(error.message)
    )

test('a limit is a whole number of at least 1, capped at the maximum', () => {
    assert.equal(parseLimit(undefined, 50, 200), 50)
    assert.equal(parseLimit('', 50, 200), 50)
    assert.equal(parseLimit('1', 50, 200), 1)
    assert.equal(parseLimit('120', 50, 200), 120)
    assert.equal(parseLimit('500', 50, 200), 200)
    for (const value of ['abc', '-1', '0', '1.5', ' 5', '0x10', '1e2', ['1', '2']])
        refused(
            () => parseLimit(value, 50, 200),
            /^limit must be a whole number of at least 1$/
        )
})

test('from and to take a date or timestamp and pass it on in UTC', () => {
    assert.equal(parseInstant('from', undefined), undefined)
    assert.equal(parseInstant('from', ''), undefined)
    assert.equal(parseInstant('from', '2026-10-01'), '2026-10-01T00:00:00.000Z')
    assert.equal(
        parseInstant('to', '2026-10-01T09:00:00+01:00'),
        '2026-10-01T08:00:00.000Z'
    )
    for (const value of ['garbage', '1', '2026-02-30', ['2026-10-01']])
        refused(
            () => parseInstant('to', value),
            /^to must be a date or timestamp such as 2026-10-01 or 2026-10-01T09:00:00Z$/
        )
})

test('a cursor is the nextCursor the previous page gave', () => {
    assert.equal(parseCursor(undefined), null)
    assert.equal(parseCursor('2026-09-30T23:12:42.241Z'), '2026-09-30T23:12:42.241Z')
    for (const value of ['garbage', '1', ['2026-09-30T23:12:42.241Z']])
        refused(() => parseCursor(value), /^invalid cursor; pass back the nextCursor/)
})

test('a user query checks its bounds and framework', () => {
    assert.deepEqual(
        buildUserQuery('usr_1', {
            from: '2026-10-01',
            framework: 'claude-code',
            agentId: 'agt_1'
        }),
        {
            userId: 'usr_1',
            from: '2026-10-01T00:00:00.000Z',
            to: undefined,
            framework: 'claude-code',
            runtimeId: undefined,
            agentId: 'agt_1',
            sessionId: undefined
        }
    )
    refused(() => buildUserQuery('usr_1', { from: 'last week' }), /^from must be/)
    refused(
        () => buildUserQuery('usr_1', { framework: 'nope' }),
        /^unknown framework: nope$/
    )
})
