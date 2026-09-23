import type { FrameworkExtension } from '../../src/modules/frameworks/framework-extension'
import type { FrameworkExtensionsRegistry } from '../../src/modules/frameworks/framework-extensions.registry'

// A registry that answers only the slots a unit test drives, without
// register()'s completeness checks.
export const extensionsWith = (
    ...extensions: Array<Partial<FrameworkExtension> & { framework: string }>
): FrameworkExtensionsRegistry => {
    const byId = new Map(extensions.map((e) => [e.framework, e]))
    return {
        get: (framework: string) => byId.get(framework)
    } as unknown as FrameworkExtensionsRegistry
}
