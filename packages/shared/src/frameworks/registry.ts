import {
    coreFrameworkDefinitions,
    coreFrameworks,
    type AgentFramework,
    type CoreFramework
} from './core'
import { UnknownFrameworkError, type FrameworkDefinition } from './definition'

interface RegistryState {
    registered: Map<string, FrameworkDefinition>
    // Set by the first listFrameworks(). A registration after that point is
    // an ordering bug: whatever listed the frameworks has already missed it.
    sealed: boolean
}

// On globalThis so a second copy of this module (dist next to source under a
// test runner or a dev server) still sees the one registry.
const STATE_KEY = Symbol.for('@manyfold/shared/framework-registry')

const registryState = (): RegistryState => {
    const holder = globalThis as { [STATE_KEY]?: RegistryState }
    holder[STATE_KEY] ??= { registered: new Map(), sealed: false }
    return holder[STATE_KEY]
}

const FRAMEWORK_ID_RE = /^[a-z][a-z0-9-]*$/

export const isCoreFramework = (id: unknown): id is CoreFramework =>
    typeof id === 'string' && Object.hasOwn(coreFrameworkDefinitions, id)

const sameDefinition = (a: FrameworkDefinition, b: FrameworkDefinition) =>
    JSON.stringify(a) === JSON.stringify(b)

// An edition's frameworks (ADR-0034). Call it from the edition's entry point,
// before anything lists the registry; registering the same definition again
// (a module evaluated twice) is a no-op.
export const registerFramework = (definition: FrameworkDefinition): void => {
    const state = registryState()
    const existing = state.registered.get(definition.id)
    if (existing) {
        if (sameDefinition(existing, definition)) return
        throw new Error(`framework '${definition.id}' is already registered`)
    }
    if (isCoreFramework(definition.id))
        throw new Error(`framework '${definition.id}' is a core framework`)
    if (state.sealed)
        throw new Error(
            `framework '${definition.id}' registered after the framework registry was listed`
        )
    if (!FRAMEWORK_ID_RE.test(definition.id))
        throw new Error(`invalid framework id '${definition.id}'`)
    if (definition.runtimes.length === 0)
        throw new Error(`framework '${definition.id}' declares no runtime`)
    if (definition.version?.repoCandidates?.length === 0)
        throw new Error(
            `framework '${definition.id}' declares an empty repo candidate list`
        )
    state.registered.set(definition.id, definition)
}

export const frameworkDefinition = (
    id: unknown
): FrameworkDefinition | undefined => {
    if (typeof id !== 'string') return undefined
    if (isCoreFramework(id)) return coreFrameworkDefinitions[id]
    return registryState().registered.get(id)
}

export const requireFrameworkDefinition = (
    id: unknown
): FrameworkDefinition => {
    const definition = frameworkDefinition(id)
    if (!definition) throw new UnknownFrameworkError(String(id))
    return definition
}

export const isRegisteredFramework = (id: unknown): id is AgentFramework =>
    frameworkDefinition(id) !== undefined

// Core frameworks in their display order, then registered ones in
// registration order. Never call this at module top level.
export const listFrameworks = (): readonly AgentFramework[] => {
    const state = registryState()
    state.sealed = true
    return [...coreFrameworks, ...state.registered.keys()]
}
