import assert from 'node:assert/strict'
import test from 'node:test'
import { chatCapabilitiesFor } from '../src/chat'
import { isReservedEnvKey } from '../src/env-vars'
import {
    frameworkCapability,
    isExternal,
    isPlatformTaskName,
    isServiceFrameworkName,
    supportsRuntime
} from '../src/framework-capability'
import {
    frameworkUpgradeMode,
    isVersionedFramework,
    listVersionedFrameworks
} from '../src/framework-versions'
import { frameworkRepoCandidates } from '../src/frameworkVersionSources'
import { coreFrameworks } from '../src/frameworks/core'
import {
    UnknownFrameworkError,
    type FrameworkDefinition
} from '../src/frameworks/definition'
import {
    frameworkDefinition,
    isCoreFramework,
    isRegisteredFramework,
    listFrameworks,
    registerFramework,
    requireFrameworkDefinition
} from '../src/frameworks/registry'

// node --test runs every file in its own process, so what this file registers
// never reaches another test file. Everything below that lists the registry
// runs after the registration test, in declaration order.
const fixture: FrameworkDefinition = {
    id: 'fixture-gateway',
    kind: 'service',
    runtimes: ['sprites', 'k8s'],
    chat: {
        streaming: true,
        toolCalls: true,
        thinking: false,
        attachments: true,
        multiTurn: true
    },
    version: {
        upgradeMode: 'rebuild',
        repoCandidates: [
            { repo: 'example/fixture-gateway', label: 'example' },
            { repo: 'example-fork/fixture-gateway', label: 'fork' }
        ]
    },
    reservedEnvPrefixes: ['FIXTUREGW_']
}

test('an unregistered id is unavailable everywhere', () => {
    assert.equal(frameworkDefinition('fixture-gateway'), undefined)
    assert.equal(isRegisteredFramework('fixture-gateway'), false)
    assert.throws(
        () => requireFrameworkDefinition('fixture-gateway'),
        (err: unknown) =>
            err instanceof UnknownFrameworkError &&
            err.code === 'framework_unavailable' &&
            err.framework === 'fixture-gateway'
    )
    assert.throws(
        () => frameworkCapability('fixture-gateway'),
        UnknownFrameworkError
    )
    assert.equal(supportsRuntime('fixture-gateway', 'sprites'), false)
    assert.equal(isExternal('fixture-gateway'), false)
    assert.equal(isVersionedFramework('fixture-gateway'), false)
    assert.equal(frameworkUpgradeMode('fixture-gateway'), null)
    assert.deepEqual(frameworkRepoCandidates('fixture-gateway'), [])
    assert.equal(isServiceFrameworkName('fixture-gateway'), false)
    assert.equal(isPlatformTaskName('fixture-gateway-keepalive'), false)
    assert.equal(chatCapabilitiesFor('fixture-gateway').toolCalls, false)
    assert.equal(chatCapabilitiesFor('fixture-gateway').thinking, false)
    assert.equal(frameworkDefinition(42), undefined)
})

test('registration rejects core ids and malformed definitions', () => {
    assert.throws(
        () => registerFramework({ ...fixture, id: 'hermes' }),
        /core framework/
    )
    assert.throws(
        () => registerFramework({ ...fixture, id: 'Fixture Gateway' }),
        /invalid framework id/
    )
    assert.throws(
        () => registerFramework({ ...fixture, runtimes: [] }),
        /declares no runtime/
    )
    assert.throws(
        () =>
            registerFramework({
                ...fixture,
                version: { upgradeMode: 'rebuild', repoCandidates: [] }
            }),
        /empty repo candidate list/
    )
    assert.equal(isRegisteredFramework('fixture-gateway'), false)
})

test('a registered framework answers like a core one', () => {
    registerFramework(fixture)
    // the same module evaluated twice registers the same definition again
    registerFramework({ ...fixture })
    assert.throws(
        () => registerFramework({ ...fixture, runtimes: ['sprites'] }),
        /already registered/
    )
    assert.equal(isRegisteredFramework('fixture-gateway'), true)
    assert.equal(isCoreFramework('fixture-gateway'), false)
    assert.equal(frameworkCapability('fixture-gateway').kind, 'service')
    assert.equal(supportsRuntime('fixture-gateway', 'k8s'), true)
    assert.equal(supportsRuntime('fixture-gateway', 'daemon'), false)
    assert.equal(frameworkUpgradeMode('fixture-gateway'), 'rebuild')
    assert.deepEqual(
        frameworkRepoCandidates('fixture-gateway').map((c) => c.repo),
        ['example/fixture-gateway', 'example-fork/fixture-gateway']
    )
    assert.equal(chatCapabilitiesFor('fixture-gateway').toolCalls, true)
    // its sprite service and legacy keep-alive task stay platform-managed
    assert.equal(isServiceFrameworkName('fixture-gateway'), true)
    assert.equal(isPlatformTaskName('fixture-gateway-keepalive'), true)
})

test('a registered framework lists after every core one', () => {
    assert.deepEqual(listFrameworks(), [...coreFrameworks, 'fixture-gateway'])
    assert.deepEqual(listVersionedFrameworks(), [
        'claude-code',
        'codex',
        'gemini-cli',
        'pi',
        'openclaw',
        'hermes',
        'narranexus',
        'fixture-gateway'
    ])
})

test('a registered framework reserves its own env prefixes', () => {
    assert.equal(isReservedEnvKey('FIXTUREGW_TOKEN'), true)
    assert.equal(isReservedEnvKey('HERMES_HOME'), true)
    assert.equal(isReservedEnvKey('MF_API_URL'), true)
    assert.equal(isReservedEnvKey('MY_SETTING'), false)
})

test('registering after the registry was listed is an ordering error', () => {
    assert.throws(
        () => registerFramework({ ...fixture, id: 'late-framework' }),
        /registered after the framework registry was listed/
    )
    assert.equal(isRegisteredFramework('late-framework'), false)
})

test('every core framework has exactly one definition keyed by its id', () => {
    for (const framework of coreFrameworks) {
        assert.equal(isCoreFramework(framework), true, framework)
        assert.equal(requireFrameworkDefinition(framework).id, framework)
    }
})
