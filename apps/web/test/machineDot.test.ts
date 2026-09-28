import assert from 'node:assert/strict'
import test from 'node:test'
import { runtimeAvailability } from '@manyfold/shared'
import type { RuntimeHostPowerState } from '@manyfold/shared'
import { agentStatusDotClass } from '../src/lib/agentStatusDot'
import { TONE_DOT, machineTone } from '../src/lib/hostStatus'

const POWER: Array<RuntimeHostPowerState | null> = [
    'running',
    'suspended',
    'stopped',
    'unknown',
    null
]

// Seen on a local stack [2026-09-28]: one sleeping sandbox was blue in the
// chat and amber under Settings › Runtimes. A ready agent's badge and its
// machine's dot are drawn from the same facts, so every combination of them
// has to come out the same colour.
test('an agent badge and its machine dot agree on every machine state', () => {
    for (const kind of ['hosted', 'local'] as const)
        for (const powerState of kind === 'local' ? [null] : POWER)
            for (const daemonOnline of [true, false]) {
                const availability = runtimeAvailability({
                    runtime: { status: 'ready' },
                    host: { kind, status: 'ready', powerState },
                    daemonOnline
                })
                assert.equal(
                    agentStatusDotClass({
                        status: 'ready',
                        availability,
                        powerState
                    }),
                    TONE_DOT[
                        machineTone({
                            kind,
                            status: 'ready',
                            powerState,
                            daemonOnline
                        })
                    ],
                    `${kind} ${powerState} daemonOnline=${daemonOnline}`
                )
            }
})

test('a sleeping sandbox is amber and an unplugged computer grey', () => {
    for (const powerState of ['suspended', 'stopped'] as const)
        assert.equal(
            TONE_DOT[
                machineTone({
                    kind: 'hosted',
                    status: 'ready',
                    powerState,
                    daemonOnline: false
                })
            ],
            TONE_DOT.warning
        )
    assert.equal(
        TONE_DOT[
            machineTone({
                kind: 'local',
                status: 'ready',
                powerState: null,
                daemonOnline: false
            })
        ],
        TONE_DOT.idle
    )
})

// A machine being built or taken down has no power story yet; its lifecycle
// is the dot, as it is for the host's own badge.
test('a machine that is not ready shows its lifecycle', () => {
    const tone = (status: 'provisioning' | 'failed' | 'deleting') =>
        machineTone({
            kind: 'hosted',
            status,
            powerState: 'running',
            daemonOnline: true
        })
    assert.equal(tone('provisioning'), 'info')
    assert.equal(tone('failed'), 'error')
    assert.equal(tone('deleting'), 'warning')
})
