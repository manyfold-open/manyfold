import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { HttpException } from '@nestjs/common'
import {
    clientKey,
    ShareRateLimitService
} from '../src/common/share-rate-limit.service'

test('consume throws 429 with retryAfterSec once the window limit is hit', () => {
    const limiter = new ShareRateLimitService()
    const args = { key: 'skills:shared:1.2.3.4', limit: 3, windowMs: 60_000 }
    limiter.consume(args)
    limiter.consume(args)
    limiter.consume(args)
    try {
        limiter.consume(args)
        assert.fail('expected a 429')
    } catch (err) {
        assert.ok(err instanceof HttpException)
        assert.equal(err.getStatus(), 429)
        const body = err.getResponse() as { retryAfterSec: number }
        assert.ok(body.retryAfterSec >= 1)
    }
})

test('a swept (expired) window resets the count', () => {
    const limiter = new ShareRateLimitService()
    const args = { key: 'skills:shared:5.6.7.8', limit: 1, windowMs: 1 }
    limiter.consume(args)
    limiter.sweep(Date.now() + 10)
    assert.doesNotThrow(() => limiter.consume(args))
})

test('clientKey prefers the first x-forwarded-for hop over req.ip', () => {
    assert.equal(
        clientKey({
            headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' },
            ip: '127.0.0.1'
        }),
        '9.9.9.9'
    )
    assert.equal(clientKey({ headers: {}, ip: '127.0.0.1' }), '127.0.0.1')
    assert.equal(clientKey({ headers: {} }), 'unknown')
})
