import assert from 'node:assert/strict'
import test from 'node:test'
import { ValidationPipe } from '@nestjs/common'
import { UpdateLoginProviderSettingsDto } from '../src/modules/auth/dto/auth-settings.dto'

// Mirrors the global pipe in src/main.ts. whitelist:true strips every body
// property that lacks a validation decorator, so any field the admin form
// sends MUST be declared on the DTO — otherwise it silently vanishes before
// the service runs. That gap is what dropped the NetMind config on save
// (form showed "Saved", refresh came back empty).
const pipe = new ValidationPipe({ whitelist: true, transform: true })
const metadata = {
    type: 'body' as const,
    metatype: UpdateLoginProviderSettingsDto,
    data: undefined
}

const baseBody = {
    passwordEnabled: true,
    emailVerificationRequired: true,
    googleEnabled: false,
    oidcEnabled: false,
    netmindEnabled: true,
    netmindAuthApi: 'https://auth-api.netmind.ai',
    netmindAccountsUrl: 'https://accounts.netmind.ai',
    netmindSysCode: 'f925fc2c',
    netmindRegisterUrl: 'https://www.netmind.ai/sign/register',
    initialAdminEmails: ['admin@example.com']
}

test('login-provider DTO survives whitelist validation with NetMind fields intact', async () => {
    const result = (await pipe.transform(
        { ...baseBody },
        metadata
    )) as UpdateLoginProviderSettingsDto

    assert.equal(result.netmindEnabled, true)
    assert.equal(result.netmindAuthApi, 'https://auth-api.netmind.ai')
    assert.equal(result.netmindAccountsUrl, 'https://accounts.netmind.ai')
    assert.equal(result.netmindSysCode, 'f925fc2c')
    assert.equal(result.netmindRegisterUrl, 'https://www.netmind.ai/sign/register')
})

test('login-provider DTO whitelist strips undeclared fields', async () => {
    const result = (await pipe.transform(
        { ...baseBody, bogusField: 'x' },
        metadata
    )) as Record<string, unknown>

    // Proves whitelist is active: an undeclared field is dropped. This is why
    // every real field (incl. every netmind* field) must be declared on the DTO.
    assert.equal('bogusField' in result, false)
})
