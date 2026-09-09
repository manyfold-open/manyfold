import assert from 'node:assert/strict'
import test from 'node:test'
import {
    isConfigurableFramework,
    frameworkCapability,
    type DaemonAuthContextRef
} from '@manyfold/shared'
import { execEnvSurfaces } from './exec-env-contract'
import {
    adapterCtx,
    buildAdapter,
    createSeam,
    drain,
    USER_MESSAGE
} from './exec-env-harness'

// ADR-0021, `auth` column: who resolves the vendor sign-in per surface. The
// contract half pins the declaration; the behaviour half drives the real
// adapters with a profile-bound factory handle and checks the runner swap
// carries the ref (a runner without it would run the sprite's native
// sign-in — exactly the downgrade the column forbids).

const RUNNER_DAEMON_ID = 'dh_runner'

const REF: DaemonAuthContextRef = {
    framework: 'codex',
    runtimeId: 'art_marker',
    profileId: 'rap_' + 'a'.repeat(26),
    bindingVersion: 7
}

test('every surface declares who resolves auth, and coding hosts never downgrade a profile', () => {
    for (const surface of execEnvSurfaces) {
        const key = `${surface.framework}/${surface.runtime}/${surface.transport}`
        const coding = frameworkCapability(surface.framework).kind === 'coding'
        if (!coding) {
            assert.equal(
                surface.auth,
                'none',
                `${key}: no vendor sign-in concept`
            )
            continue
        }
        if (
            surface.transport === 'daemon-exec' ||
            surface.transport === 'runner-exec'
        )
            assert.equal(
                surface.auth,
                'host-resolved',
                `${key}: a daemon resolves the profile context`
            )
        else if (
            surface.transport === 'sprite-exec' ||
            surface.transport === 'pod-exec'
        )
            assert.equal(
                surface.auth,
                'ambient',
                `${key}: no host code here; a bound agent is refused`
            )
        else assert.fail(`${key}: unexpected transport for a coding framework`)
    }
})

for (const surface of execEnvSurfaces.filter(
    (s) => s.transport === 'runner-exec' && s.auth === 'host-resolved'
)) {
    if (!isConfigurableFramework(surface.framework)) continue
    const key = `${surface.framework}/${surface.runtime}/runner-exec`
    test(`${key} hands the profile ref to the runner driver`, async () => {
        const seam = createSeam()
        const adapter = buildAdapter(seam, {
            framework: surface.framework,
            runtime: surface.runtime,
            authContext: { ...REF, framework: surface.framework as never }
        })
        await drain(
            adapter.sendMessage(
                adapterCtx(surface.framework, surface.runtime, {
                    runnerDaemonId: RUNNER_DAEMON_ID
                } as never),
                USER_MESSAGE
            )
        )
        assert.equal(seam.runnerDrivers.length, 1, `${key}: one runner swap`)
        assert.deepEqual(seam.runnerDrivers[0].authContext, {
            ...REF,
            framework: surface.framework
        })
    })
}
