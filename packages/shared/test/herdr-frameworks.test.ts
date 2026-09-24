import assert from 'node:assert/strict'
import test from 'node:test'
import {
    DAEMON_FEATURE_HERDR_PI,
    DAEMON_FEATURE_HERDR_TERMINAL,
    herdrFrameworksFor
} from '../src/daemon'

// What a host can hand to herdr follows its CLI's features: nothing without
// the handoff, claude and codex with it, and pi only from a CLI that knows
// pi's herdr kind (ADR-0031, ADR-0032).
test('the herdr frameworks follow the handoff and the pi kind', () => {
    assert.deepEqual(herdrFrameworksFor([]), [])
    assert.deepEqual(herdrFrameworksFor([DAEMON_FEATURE_HERDR_PI]), [])
    assert.deepEqual(herdrFrameworksFor([DAEMON_FEATURE_HERDR_TERMINAL]), [
        'claude-code',
        'codex'
    ])
    assert.deepEqual(
        herdrFrameworksFor([
            DAEMON_FEATURE_HERDR_TERMINAL,
            DAEMON_FEATURE_HERDR_PI
        ]),
        ['claude-code', 'codex', 'pi']
    )
})
