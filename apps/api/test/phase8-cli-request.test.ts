import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { GoneException } from '@nestjs/common'
import { CliAuthController } from '../src/modules/auth/cli-auth.controller'
import { CliAuthRateLimitService } from '../src/modules/auth/cli-auth-rate-limit.service'

test('legacy grant requests cannot silently become account-wide browser logins', async () => {
    let starts = 0
    const controller = new CliAuthController(
        {
            start: async () => {
                starts++
                return {}
            }
        } as never,
        new CliAuthRateLimitService()
    )
    for (const body of [
        { requestedScopes: ['channels:read'] },
        { requestedScopes: [] },
        { requestedScopes: null },
        { requestedAgentId: '' },
        { requestedAgentId: 'agt_A', redirectUri: 'http://127.0.0.1:1234/' }
    ]) {
        await assert.rejects(
            controller.start(
                body as never,
                { ip: '127.0.0.1', headers: {} } as never
            ),
            GoneException
        )
    }
    assert.equal(starts, 0)
    await controller.start({}, { ip: '127.0.0.1', headers: {} } as never)
    assert.equal(starts, 1)
})
