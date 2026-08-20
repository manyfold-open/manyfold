import type { UpdateEmailProviderSettingsBody } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { EmailSettingsService } from '../src/modules/email/email-settings.service'
import { smtpTransportOptions } from '../src/modules/email/email.service'

const stubCrypto = {
    encrypt: (plain: string) => ({ ciphertext: `enc:${plain}`, keyVersion: 1 }),
    decrypt: ({ ciphertext }: { ciphertext: string }) =>
        ciphertext.replace(/^enc:/, '')
}

type Internals = {
    normalizeForStorage(
        input: UpdateEmailProviderSettingsBody,
        existing: unknown
    ): Record<string, unknown>
    resolveStored(stored: unknown): Record<string, unknown>
}

const service = (): Internals =>
    new EmailSettingsService(
        {} as never,
        stubCrypto as never
    ) as unknown as Internals

const smtpInput: UpdateEmailProviderSettingsBody = {
    provider: 'smtp',
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpSecure: false,
    smtpUsername: 'mailer',
    smtpPassword: 'hunter2-hunter2',
    smtpFrom: 'Manyfold <no-reply@example.com>',
    smtpReplyTo: null
}

test('smtp settings: store encrypts the password and resolve round-trips it', () => {
    const svc = service()
    const stored = svc.normalizeForStorage(smtpInput, null)
    const smtp = stored.smtp as Record<string, unknown>
    assert.equal(smtp.passwordCiphertext, 'enc:hunter2-hunter2')
    assert.ok(String(smtp.passwordMasked).includes('***'))
    const resolved = svc.resolveStored(stored)
    assert.deepEqual(resolved, {
        provider: 'smtp',
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        username: 'mailer',
        password: 'hunter2-hunter2',
        from: 'Manyfold <no-reply@example.com>',
        replyTo: null
    })
})

test('smtp settings: omitting the password keeps the stored one', () => {
    const svc = service()
    const first = svc.normalizeForStorage(smtpInput, null)
    const second = svc.normalizeForStorage(
        { ...smtpInput, smtpPassword: undefined, smtpHost: 'smtp2.example.com' },
        first
    )
    const smtp = second.smtp as Record<string, unknown>
    assert.equal(smtp.host, 'smtp2.example.com')
    assert.equal(smtp.passwordCiphertext, 'enc:hunter2-hunter2')
})

test('smtp settings: username without any password is rejected', () => {
    const svc = service()
    assert.throws(
        () =>
            svc.normalizeForStorage(
                { ...smtpInput, smtpPassword: undefined },
                null
            ),
        /smtpPassword is required/
    )
})

test('smtp settings: unauthenticated relay needs no credentials', () => {
    const svc = service()
    const stored = svc.normalizeForStorage(
        {
            ...smtpInput,
            smtpUsername: null,
            smtpPassword: undefined
        },
        null
    )
    const resolved = svc.resolveStored(stored) as { username: unknown; password: unknown }
    assert.equal(resolved.username, null)
    assert.equal(resolved.password, null)
})

test('smtp settings: port bounds are enforced', () => {
    const svc = service()
    assert.throws(
        () => svc.normalizeForStorage({ ...smtpInput, smtpPort: 0 }, null),
        /smtpPort/
    )
    assert.throws(
        () => svc.normalizeForStorage({ ...smtpInput, smtpPort: 70_000 }, null),
        /smtpPort/
    )
})

test('email settings: switching providers never drops stored secrets', () => {
    const svc = service()
    const withSmtp = svc.normalizeForStorage(smtpInput, null)
    const toResend = svc.normalizeForStorage(
        {
            provider: 'resend',
            resendFrom: 'no-reply@example.com',
            // Any non-empty string works; shaped to stay off gitleaks radar.
            resendApiKey: 'resend key placeholder for tests'
        },
        withSmtp
    )
    assert.ok(toResend.smtp, 'smtp block carried through resend switch')
    const toConsole = svc.normalizeForStorage({ provider: 'console' }, toResend)
    assert.ok(toConsole.smtp, 'smtp block carried through console switch')
    assert.ok(toConsole.resend, 'resend block carried through console switch')
    const backToSmtp = svc.normalizeForStorage(
        { ...smtpInput, smtpPassword: undefined },
        toConsole
    )
    const smtp = (backToSmtp as { smtp: { passwordCiphertext: string } }).smtp
    assert.equal(smtp.passwordCiphertext, 'enc:hunter2-hunter2')
})

test('smtp transport options: auth only when a username is set', () => {
    const base = {
        provider: 'smtp' as const,
        host: 'smtp.example.com',
        port: 465,
        secure: true,
        username: null,
        password: null,
        from: 'a@example.com',
        replyTo: null
    }
    const open = smtpTransportOptions(base)
    assert.equal(open.secure, true)
    assert.ok(!('auth' in open))
    const authed = smtpTransportOptions({
        ...base,
        username: 'mailer',
        password: 'pw'
    })
    assert.deepEqual(authed.auth, { user: 'mailer', pass: 'pw' })
    assert.ok(authed.connectionTimeout > 0)
})
