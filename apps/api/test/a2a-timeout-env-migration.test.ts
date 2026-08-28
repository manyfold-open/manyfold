import assert from 'node:assert/strict'
import test from 'node:test'
import { A2aTimeoutEnvMigrationService } from '../src/modules/a2a-timeout-env-migration/a2a-timeout-env-migration.service'

// Both gates sit in front of every database call, so a db that throws on
// contact is the strongest available proof that they short-circuit.
const explodingDb = new Proxy(
    {},
    {
        get() {
            throw new Error('database must not be touched')
        }
    }
) as never

const explodingSettings = new Proxy(
    {},
    {
        get() {
            throw new Error('admin settings must not be touched')
        }
    }
) as never

const config = (value?: string): never =>
    ({ get: () => value }) as unknown as never

test('migration does nothing when the env var is absent or blank', async () => {
    for (const value of [undefined, '', '   ']) {
        const service = new A2aTimeoutEnvMigrationService(
            explodingDb,
            config(value),
            explodingSettings
        )
        assert.deepEqual(
            await service.run(),
            { applied: false, reason: 'env-absent' },
            `A2A_TURN_TIMEOUT_MS=${JSON.stringify(value)} must not start a migration`
        )
    }
})

test('migration rejects values that are not a positive millisecond count', async () => {
    for (const value of ['abc', '-5', '0', 'NaN', 'Infinity']) {
        const service = new A2aTimeoutEnvMigrationService(
            explodingDb,
            config(value),
            explodingSettings
        )
        assert.deepEqual(
            await service.run(),
            { applied: false, reason: 'env-invalid' },
            `A2A_TURN_TIMEOUT_MS=${JSON.stringify(value)} must be ignored (the old env path treated it as unset)`
        )
    }
})
