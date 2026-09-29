import {
    frameworkDefinition,
    isCoreFramework,
    listFrameworks,
    type AgentFramework
} from '@manyfold/shared'
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common'
import { registerServiceFrameworkRecipe } from '@/modules/agents/bootstrap/service-frameworks'
import { registerFrameworkVersionDescriptor } from '@/modules/framework-versions/framework-version-registry'
import type { FrameworkExtension } from './framework-extension'

// The API half of a framework the core dispatch tables do not handle
// (ADR-0034): its adapters, bootstraps and hooks, registered by the module
// that owns it. Core dispatch points look an id up in their own tables first
// and then here; an id neither knows gets UnknownFrameworkError.
@Injectable()
export class FrameworkExtensionsRegistry implements OnApplicationBootstrap {
    private readonly extensions = new Map<string, FrameworkExtension>()

    register(extension: FrameworkExtension): void {
        const id = extension.framework
        if (this.extensions.has(id))
            throw new Error(`framework '${id}' already has an extension`)
        const definition = frameworkDefinition(id)
        if (!definition)
            throw new Error(
                `framework '${id}' has no registered definition — call registerFramework first`
            )
        if (
            extension.agentAdapter.framework !== id ||
            extension.chatAdapter.framework !== id
        )
            throw new Error(`framework '${id}' adapters name another framework`)
        const missing = (slot: string): never => {
            throw new Error(`framework '${id}' is missing its ${slot}`)
        }
        const hosted =
            definition.runtimes.includes('sprites') ||
            definition.runtimes.includes('k8s')
        if (definition.kind === 'service' && hosted && !extension.serviceRecipe)
            missing('service recipe')
        if (extension.serviceRecipe && extension.serviceRecipe.framework !== id)
            throw new Error(`framework '${id}' service recipe names another framework`)
        if (definition.version && !extension.version)
            missing('version descriptor')
        if (
            definition.version?.upgradeMode === 'rebuild' &&
            !extension.version?.rebuildShells
        )
            missing('rebuild shells')
        if (definition.files?.servedBy === 'framework' && !extension.files)
            missing('files provider')
        if (extension.version)
            registerFrameworkVersionDescriptor(extension.version.descriptor)
        if (extension.serviceRecipe)
            registerServiceFrameworkRecipe(extension.serviceRecipe)
        this.extensions.set(id, extension)
    }

    // Every module has registered by now (constructors run before this hook):
    // a framework whose definition is registered but whose module was never
    // wired into the app would otherwise fail on its first request.
    onApplicationBootstrap(): void {
        const uncovered = listFrameworks().filter(
            (id) => !isCoreFramework(id) && !this.extensions.has(id)
        )
        if (uncovered.length > 0)
            throw new Error(
                `frameworks registered without an API extension: ${uncovered.join(', ')}`
            )
    }

    get(framework: AgentFramework): FrameworkExtension | undefined {
        return this.extensions.get(framework)
    }
}
