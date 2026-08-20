import assert from 'node:assert/strict'
import test from 'node:test'
import {
    BadGatewayException,
    BadRequestException,
    ConflictException,
    NotFoundException
} from '@nestjs/common'
import { SpritesError } from '@manyfold/sprites'
import { spritesHttpError } from '../src/modules/agents/files/sprite-http-error'

const caught = (fn: () => never): unknown => {
    try {
        fn()
    } catch (err) {
        return err
    }
    throw new Error('expected spritesHttpError to throw')
}

const codeOf = (err: unknown): string | undefined =>
    (
        (err as { getResponse?: () => unknown }).getResponse?.() as {
            code?: string
        }
    )?.code

// The #264 symptom was a downstream exec 401 surfacing as a generic 500
// internal_error. A revoked token / exec failure is OUR runtime being
// unavailable, not the caller's own auth problem — so it must map to a 502
// runtime_unavailable, never a 401 that would wrongly tell the caller to
// re-authenticate, and never fall through to internal_error.
test('auth SpritesError maps to 502 runtime_unavailable, not 401', () => {
    const err = caught(() =>
        spritesHttpError(new SpritesError('auth', 'exec 401', 401))
    )
    assert.ok(err instanceof BadGatewayException)
    assert.equal(codeOf(err), 'runtime_unavailable')
})

test('transient SpritesError maps to 502 runtime_unavailable', () => {
    const err = caught(() =>
        spritesHttpError(new SpritesError('transient', 'timed out'))
    )
    assert.ok(err instanceof BadGatewayException)
    assert.equal(codeOf(err), 'runtime_unavailable')
})

test('quota SpritesError maps to 502 runtime_unavailable', () => {
    const err = caught(() =>
        spritesHttpError(new SpritesError('quota', 'rate limited', 429))
    )
    assert.ok(err instanceof BadGatewayException)
    assert.equal(codeOf(err), 'runtime_unavailable')
})

test('not_found SpritesError maps to 404 not_found', () => {
    const err = caught(() =>
        spritesHttpError(new SpritesError('not_found', 'no such dir'))
    )
    assert.ok(err instanceof NotFoundException)
    assert.equal(codeOf(err), 'not_found')
})

test('conflict SpritesError maps to 409 conflict', () => {
    const err = caught(() =>
        spritesHttpError(new SpritesError('conflict', 'exists', 409))
    )
    assert.ok(err instanceof ConflictException)
    assert.equal(codeOf(err), 'conflict')
})

test('permanent SpritesError maps to 400 bad_request', () => {
    const err = caught(() =>
        spritesHttpError(new SpritesError('permanent', 'bad path'))
    )
    assert.ok(err instanceof BadRequestException)
    assert.equal(codeOf(err), 'bad_request')
})

// A non-SpritesError (e.g. a NestJS exception thrown earlier in the op, like
// the NotFoundException for a missing account) must pass through untouched so
// its own status/code is preserved rather than masked as a runtime error.
test('non-SpritesError is rethrown unchanged', () => {
    const original = new NotFoundException('sprites account not found')
    const err = caught(() => spritesHttpError(original))
    assert.equal(err, original)
})
