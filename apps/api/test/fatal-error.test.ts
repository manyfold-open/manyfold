import test from 'node:test'
import assert from 'node:assert/strict'
import { describeFatalError } from '../src/fatal-error'

test('an Error keeps its class, message and a stack that locates the throw site', () => {
    const detail = describeFatalError(new TypeError('db pool exhausted'))
    assert.equal(detail.errorClass, 'TypeError')
    assert.equal(detail.errorMessage, 'db pool exhausted')
    assert.ok(detail.stack?.includes('fatal-error.test'))
})

test('an Error with a blank name still reports a usable class', () => {
    const err = new Error('boom')
    err.name = ''
    assert.equal(describeFatalError(err).errorClass, 'Error')
})

test('message and stack are capped so one record cannot blow up the log pipeline', () => {
    const err = new Error('m'.repeat(10_000))
    err.stack = 's'.repeat(10_000)
    const detail = describeFatalError(err)
    assert.ok(detail.errorMessage.length <= 2_048 + ' [truncated]'.length)
    assert.ok(detail.errorMessage.endsWith(' [truncated]'))
    assert.ok(detail.stack !== undefined)
    assert.ok(detail.stack.length <= 4_096 + ' [truncated]'.length)
    assert.ok(detail.stack.endsWith(' [truncated]'))
})

test('a short message and stack are passed through untouched', () => {
    const detail = describeFatalError(new Error('short'))
    assert.equal(detail.errorMessage, 'short')
    assert.ok(
        detail.stack !== undefined && !detail.stack.endsWith('[truncated]')
    )
})

test('a non-Error object keeps its readable shape instead of "[object Object]"', () => {
    const detail = describeFatalError({ foo: 1 })
    assert.equal(detail.errorClass, 'NonError(object)')
    assert.ok(detail.errorMessage.includes('foo: 1'))
    assert.ok(!detail.errorMessage.includes('[object Object]'))
    assert.equal(detail.stack, undefined)
})

test('primitive rejection reasons are classified and preserved', () => {
    assert.deepEqual(describeFatalError('plain reason'), {
        errorClass: 'NonError(string)',
        errorMessage: "'plain reason'"
    })
    assert.equal(
        describeFatalError(undefined).errorClass,
        'NonError(undefined)'
    )
})

test('a null-prototype reason must not throw — String() on it threw inside handleFatal after the guard latched, leaving the process alive but blind to all further fatals', () => {
    const reason = Object.assign(Object.create(null), { code: 42 })
    assert.throws(() => String(reason))
    const detail = describeFatalError(reason)
    assert.equal(detail.errorClass, 'NonError(object)')
    assert.ok(detail.errorMessage.includes('code: 42'))
})

test('a reason whose toString throws must not throw', () => {
    const detail = describeFatalError({
        toString() {
            throw new Error('poisoned')
        }
    })
    assert.equal(detail.errorClass, 'NonError(object)')
    assert.ok(detail.errorMessage.length > 0)
})

test('a circular reason must not throw', () => {
    const reason: Record<string, unknown> = { name: 'loop' }
    reason.self = reason
    const detail = describeFatalError(reason)
    assert.ok(detail.errorMessage.includes('Circular'))
})

test('an Error whose own getters throw falls back instead of throwing', () => {
    const err = new Error('x')
    Object.defineProperty(err, 'name', {
        get() {
            throw new Error('poisoned getter')
        }
    })
    const detail = describeFatalError(err)
    assert.equal(detail.errorClass, 'UndescribableValue')
    assert.equal(detail.errorMessage, '[value could not be described]')
})

test('an Error carrying a non-string message at runtime is still described', () => {
    const err = new Error('x')
    ;(err as unknown as { message: unknown }).message = { nested: true }
    const detail = describeFatalError(err)
    assert.equal(detail.errorClass, 'Error')
    assert.equal(detail.errorMessage, '[object Object]')
})
