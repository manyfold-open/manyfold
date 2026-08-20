import assert from 'node:assert/strict'
import test from 'node:test'
import { ConfigService } from '@nestjs/config'
import {
    A2aTicketError,
    A2aTicketService
} from '../src/modules/a2a/a2a-ticket.service'
import { CryptoService } from '../src/modules/secrets/crypto.service'
import { isApiToken } from '../src/modules/auth/api-token.service'

const TEST_KEY = Buffer.alloc(32, 7).toString('base64')

const buildService = (): A2aTicketService =>
    new A2aTicketService(
        new CryptoService(new ConfigService({ API_CRYPTO_KEY: TEST_KEY }))
    )

test('sign → verify round-trips the payload', () => {
    const svc = buildService()
    const { ticket, exp } = svc.sign({
        callerAgentId: 'agt_caller',
        targetAgentId: 'agt_target',
        userId: 'user-1'
    })
    const payload = svc.verify(ticket)
    assert.equal(payload.callerAgentId, 'agt_caller')
    assert.equal(payload.targetAgentId, 'agt_target')
    assert.equal(payload.userId, 'user-1')
    assert.equal(payload.exp, exp)
    assert.ok(exp > Date.now())
})

test('isA2aTicket recognizes the mfa2a_ prefix only', () => {
    const svc = buildService()
    const { ticket } = svc.sign({
        callerAgentId: 'agt_caller',
        targetAgentId: 'agt_target',
        userId: 'user-1'
    })
    assert.equal(svc.isA2aTicket(ticket), true)
    assert.equal(svc.isA2aTicket('nca_abc'), false)
    assert.equal(svc.isA2aTicket('nca_rt_abc'), false)
})

test('a ticket does NOT satisfy isApiToken (no nca_ prefix; routing guard)', () => {
    // The ticket must never be mistaken for an api token — isApiToken gates the
    // legacy DB-token branch and the OpenAI /v1 surface keys on the nca_ family.
    const svc = buildService()
    const { ticket } = svc.sign({
        callerAgentId: 'agt_caller',
        targetAgentId: 'agt_target',
        userId: 'user-1'
    })
    assert.ok(ticket.startsWith('mfa2a_'))
    assert.equal(isApiToken(ticket), false)
})

test('verify throws A2aTicketError(corrupt) on a tampered ticket', () => {
    const svc = buildService()
    const { ticket } = svc.sign({
        callerAgentId: 'agt_caller',
        targetAgentId: 'agt_target',
        userId: 'user-1'
    })
    const tampered = ticket.slice(0, -4) + 'AAAA'
    assert.throws(
        () => svc.verify(tampered),
        (err: unknown) =>
            err instanceof A2aTicketError && err.reason === 'corrupt'
    )
})

test('verify throws A2aTicketError(corrupt) on a non-ticket string', () => {
    const svc = buildService()
    assert.throws(
        () => svc.verify('mfa2a_not-base64-or-encrypted'),
        (err: unknown) =>
            err instanceof A2aTicketError && err.reason === 'corrupt'
    )
})

test('verify throws A2aTicketError(expired) when exp is in the past', () => {
    const config = new ConfigService({ API_CRYPTO_KEY: TEST_KEY })
    const crypto = new CryptoService(config)
    const svc = new A2aTicketService(crypto)
    // Forge an otherwise-valid ticket whose exp already elapsed.
    const enc = crypto.encrypt(
        JSON.stringify({
            callerAgentId: 'agt_caller',
            targetAgentId: 'agt_target',
            userId: 'user-1',
            exp: 1
        })
    )
    const expired =
        'mfa2a_' + Buffer.from(JSON.stringify(enc)).toString('base64url')
    assert.throws(
        () => svc.verify(expired),
        (err: unknown) =>
            err instanceof A2aTicketError && err.reason === 'expired'
    )
})

test('verify throws A2aTicketError(corrupt) on a shape-invalid payload', () => {
    const config = new ConfigService({ API_CRYPTO_KEY: TEST_KEY })
    const crypto = new CryptoService(config)
    const svc = new A2aTicketService(crypto)
    const enc = crypto.encrypt(JSON.stringify({ callerAgentId: 'agt_caller' }))
    const bad =
        'mfa2a_' + Buffer.from(JSON.stringify(enc)).toString('base64url')
    assert.throws(
        () => svc.verify(bad),
        (err: unknown) =>
            err instanceof A2aTicketError && err.reason === 'corrupt'
    )
})
