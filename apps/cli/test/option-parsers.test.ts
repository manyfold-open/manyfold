import test from 'node:test'
import assert from 'node:assert/strict'
import { CommanderError, InvalidArgumentError } from 'commander'
import { instantOption, limitOption } from '../src/option-parsers'
import { runMf } from './fixtures/fake-api'

test('a limit is digits from 1 to the maximum', () => {
    const parse = limitOption(200)
    assert.equal(parse('1'), 1)
    assert.equal(parse('200'), 200)
    for (const value of ['0', '201', '-1', 'abc', '1.5', ' 5', '0x10', '1e2', ''])
        assert.throws(() => parse(value), InvalidArgumentError, value)
})

test('an instant is a date, or a date and time, as the API reads it', () => {
    assert.equal(instantOption('2026-10-01'), '2026-10-01')
    assert.equal(
        instantOption('2026-10-01T09:00:00+01:00'),
        '2026-10-01T09:00:00+01:00'
    )
    for (const value of ['garbage', '1', '2026-02-30', 'yesterday'])
        assert.throws(() => instantOption(value), InvalidArgumentError, value)
})

test('mcp catalog list and skills discover refuse a bad --limit before sending', async () => {
    for (const args of [
        ['mcp', 'catalog', 'list', '--limit', '0'],
        ['mcp', 'catalog', 'list', '--limit', '101'],
        ['skills', 'discover', '--limit', 'abc']
    ]) {
        const run = await runMf(args)
        assert.ok(run.error instanceof CommanderError, args.join(' '))
        assert.match(
            run.error.message,
            /argument '[^']*' is invalid\. limit must be a whole number from 1 to 100$/
        )
        assert.deepEqual(run.calls, [], args.join(' '))
    }
})
