import type { UpdateFrameworkDefaultVersionsSettingsBody } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ValidationPipe } from '@nestjs/common'
import { UpdateFrameworkDefaultVersionsSettingsDto } from '../src/modules/admin-settings/dto/admin-settings.dto'

// The API runs one global `ValidationPipe({ whitelist: true, transform: true })`
// (main.ts), which STRIPS every body property the DTO class does not declare.
// `implements <Body>` cannot catch an omission, because a class that leaves out
// an OPTIONAL interface property still satisfies the interface — so a field
// added to the shared body type and to the service, but forgotten on the DTO,
// compiles, typechecks, passes every service-level unit test, and then silently
// does nothing in production.
//
// That is exactly how the pre-release opt-in shipped broken: Admin PUT its
// `allowPrerelease` map, the pipe removed it, the service read `undefined` as
// "unchanged", and the response came back with the toggle still off. Every test
// added with that feature called the service directly and so never saw the pipe.
//
// `Required<...>` is what makes this a standing guard rather than a one-off: add
// a property to the shared body type and this object stops compiling until it is
// listed here, at which point the assertion checks it also survives the pipe.
const FULL_BODY: Required<UpdateFrameworkDefaultVersionsSettingsBody> = {
    defaults: { narranexus: '1.15.1-rc.1' },
    minVersions: { narranexus: 'v1.15.0' },
    allowDowngrade: { narranexus: false },
    blockedVersions: {
        narranexus: [{ min: 'v1.7.0', max: 'v1.7.1', reason: 'bad window' }]
    },
    sourceRepos: { narranexus: 'protagolabs/NarraNexus' },
    allowPrerelease: { narranexus: true }
}

const throughPipe = async (body: unknown): Promise<Record<string, unknown>> =>
    (await new ValidationPipe({
        whitelist: true,
        transform: true
    }).transform(body, {
        type: 'body',
        metatype: UpdateFrameworkDefaultVersionsSettingsDto
    })) as Record<string, unknown>

test('every framework-version settings field survives the global whitelist pipe', async () => {
    const received = await throughPipe(FULL_BODY)

    for (const key of Object.keys(FULL_BODY))
        assert.deepEqual(
            received[key],
            FULL_BODY[key as keyof typeof FULL_BODY],
            `${key} did not survive the whitelist pipe — declare it on UpdateFrameworkDefaultVersionsSettingsDto`
        )
})

// The other half of the contract the service depends on: an omitted map has to
// arrive as `undefined` and NOT as `{}`, because `undefined` is what
// updateFrameworkDefaultVersions reads as "keep what is stored". If the pipe
// ever defaulted these to empty objects, saving from an older Admin build would
// wipe an operator's blocked windows, source repo and pre-release channel.
test('an omitted map arrives as undefined, not as an empty object', async () => {
    const received = await throughPipe({ defaults: {} })

    for (const key of [
        'minVersions',
        'allowDowngrade',
        'blockedVersions',
        'sourceRepos',
        'allowPrerelease'
    ])
        assert.equal(received[key], undefined, key)
})
