import assert from 'node:assert/strict'
import test from 'node:test'
import {
    UnknownFrameworkError,
    registerFramework,
    type FrameworkDefinition
} from '@manyfold/shared'
import { AgentAdapterRegistry } from '../src/modules/agents/adapters/adapter-registry'
import { FrameworkExtensionsRegistry } from '../src/modules/frameworks/framework-extensions.registry'
import type { FrameworkExtension } from '../src/modules/frameworks/framework-extension'
import { frameworkVersionDescriptor } from '../src/modules/framework-versions/framework-version-registry'

// Runs in its own process (node --test), so the definition this file
// registers never reaches another test file.
const definition: FrameworkDefinition = {
    id: 'fixture-gateway',
    displayName: 'Fixture Gateway',
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
        repoCandidates: [{ repo: 'example/fixture-gateway', label: 'example' }]
    },
    files: { servedBy: 'framework' }
}
registerFramework(definition)

const adapter = (framework: string) => ({ framework }) as never

const complete = (): FrameworkExtension => ({
    framework: 'fixture-gateway',
    agentAdapter: adapter('fixture-gateway'),
    chatAdapter: adapter('fixture-gateway'),
    spriteService: {
        bootstrap: adapter('fixture-gateway'),
        mountPath: '/home/sprite/.fixture',
        workspaceSeed: () => '/home/sprite/.fixture/workspace',
        supervision: {
            homeDir: '/home/sprite/.fixture',
            healthUrl: 'http://127.0.0.1:9000/healthz',
            fallbackExec: () => ['fixture']
        }
    },
    version: {
        descriptor: {
            framework: 'fixture-gateway',
            runtimeKind: 'daemon',
            source: { kind: 'github', repo: 'example/fixture-gateway' },
            binName: 'fixture',
            probeShell: 'true'
        },
        rebuildShells: () => ({ rebuild: 'true', restore: 'true' })
    },
    files: {
        resolveRoots: async () => [],
        buildContext: async () => null
    }
})

test('an extension must match a registered definition, slot for slot', () => {
    const registry = new FrameworkExtensionsRegistry()
    assert.throws(
        () => registry.register({ ...complete(), framework: 'not-defined' }),
        /no registered definition/
    )
    assert.throws(
        () =>
            registry.register({
                ...complete(),
                chatAdapter: adapter('another-framework')
            }),
        /adapters name another framework/
    )
    for (const slot of ['spriteService', 'version', 'files'] as const)
        assert.throws(
            () => registry.register({ ...complete(), [slot]: undefined }),
            /is missing its/,
            slot
        )
    assert.throws(
        () =>
            registry.register({
                ...complete(),
                version: { ...complete().version!, rebuildShells: undefined }
            }),
        /missing its rebuild shells/
    )
})

test('a registered framework without its extension fails at boot', () => {
    assert.throws(
        () => new FrameworkExtensionsRegistry().onApplicationBootstrap(),
        /frameworks registered without an API extension: fixture-gateway/
    )
})

test('a complete extension is served to the core dispatch points', () => {
    const registry = new FrameworkExtensionsRegistry()
    const extension = complete()
    registry.register(extension)
    registry.onApplicationBootstrap()
    assert.throws(
        () => registry.register(complete()),
        /already has an extension/
    )
    assert.equal(registry.get('fixture-gateway'), extension)
    // its version descriptor joins the module-level table the free
    // functions read
    assert.equal(
        frameworkVersionDescriptor('fixture-gateway'),
        extension.version!.descriptor
    )

    const agents = new AgentAdapterRegistry(
        adapter('claude-code'),
        adapter('codex'),
        adapter('gemini-cli'),
        adapter('pi'),
        adapter('openclaw'),
        adapter('hermes'),
        adapter('dify'),
        adapter('langflow'),
        adapter('a2a'),
        registry
    )
    assert.equal(agents.get('claude-code').framework, 'claude-code')
    assert.equal(agents.get('fixture-gateway'), extension.agentAdapter)
    assert.throws(() => agents.get('retired-framework'), UnknownFrameworkError)
})
