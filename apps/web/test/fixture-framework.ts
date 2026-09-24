import type { FrameworkDefinition } from '@manyfold/shared'
import { registerFrameworkPresentation } from '../src/lib/frameworkPresentation'

// A framework an edition registers (ADR-0034), shaped like the service
// frameworks editions add: providers managed in its own UI, a native UI that
// is always on, schedules of its own, and no daemon host. Importing this file
// registers it; each test file runs in its own process.
export const FIXTURE_FRAMEWORK = 'fixture-gateway'

const definition: FrameworkDefinition = {
    id: FIXTURE_FRAMEWORK,
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
    credentials: 'runtime-ui',
    nativeUi: 'always',
    schedules: 'mirrored'
}

registerFrameworkPresentation({
    definition,
    labelKey: 'fixture.label',
    icon: { light: 'fixture-gateway.svg' },
    descriptionKey: 'fixture.description',
    identityKey: 'fixture.identity',
    capabilities: ['channels'],
    launchpad: { actionIds: ['native', 'channel'], recommended: 'native' },
    defaultWorkspacePath: (hostKind) => `/srv/fixture/${hostKind}/{agent-id}`
})
