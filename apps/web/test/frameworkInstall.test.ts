import assert from 'node:assert/strict'
import test from 'node:test'
import {
    frameworkOnHostState,
    installedFrameworkVersion,
    serviceSlotOccupant
} from '../src/lib/agentCreate/frameworkInstall'

test('a framework the sandbox never reported is missing, whatever the catalog says', () => {
    assert.deepEqual(frameworkOnHostState(null, '2.1.300'), { kind: 'missing' })
    assert.deepEqual(frameworkOnHostState(null, null), { kind: 'missing' })
})

test('an installed framework is judged against the catalog latest by precedence', () => {
    assert.deepEqual(frameworkOnHostState('2.1.268', '2.1.300'), {
        kind: 'outdated',
        installed: '2.1.268',
        latest: '2.1.300'
    })
    assert.deepEqual(frameworkOnHostState('2.1.300', '2.1.300'), {
        kind: 'current',
        installed: '2.1.300'
    })
    // Ahead of the catalog (a preview build) is not something to "upgrade".
    assert.deepEqual(frameworkOnHostState('2.2.0', '2.1.300'), {
        kind: 'current',
        installed: '2.2.0'
    })
})

test('with no catalog the installed version is shown but not judged', () => {
    assert.deepEqual(frameworkOnHostState('2.1.268', null), {
        kind: 'unknown',
        installed: '2.1.268'
    })
})

test('the sandbox probe is read per framework', () => {
    const sandbox = {
        detectedFrameworks: [
            {
                framework: 'claude-code' as const,
                version: '2.1.268',
                path: '~/.local/bin/claude'
            },
            {
                framework: 'codex' as const,
                version: '0.60.0',
                path: '~/.local/bin/codex'
            }
        ]
    }
    assert.equal(installedFrameworkVersion(sandbox, 'claude-code'), '2.1.268')
    assert.equal(installedFrameworkVersion(sandbox, 'gemini-cli'), null)
    assert.equal(installedFrameworkVersion(null, 'codex'), null)
})

test('a sandbox holds one service framework: the occupant blocks the other two, coding CLIs never do', () => {
    assert.equal(serviceSlotOccupant([]), null)
    assert.equal(serviceSlotOccupant(['claude-code', 'codex']), null)
    assert.equal(
        serviceSlotOccupant(['claude-code', 'openclaw', 'codex']),
        'openclaw'
    )
    assert.equal(serviceSlotOccupant(['hermes']), 'hermes')
})
