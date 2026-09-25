import {
    AgentFramework,
    AgentRuntime,
    K8S_HOME_BASE,
    frameworkCapability
} from '@manyfold/shared'
import type { FileRoot } from '@manyfold/db'

export const HOME_ROOT_ID = 'home'

export interface FileRootsContext {
    framework: AgentFramework
    runtime: AgentRuntime
    mountPath: string
    homeDir?: string | null
    workspaceTransport?: FileRoot['transport']
}

const homeRoot = (
    path: string,
    transport?: FileRoot['transport']
): FileRoot => ({
    id: HOME_ROOT_ID,
    label: 'Home',
    path,
    writable: true,
    ...(transport ? { transport } : {})
})

export const buildFileRoots = (ctx: FileRootsContext): FileRoot[] => {
    const { framework, runtime, mountPath } = ctx
    if (runtime === 'external') return []
    // A pod host serves every root through pod exec (ADR-0035): nothing on the
    // host is published over HTTP.
    const podExec = runtime === 'k8s' ? { transport: 'pod-exec' as const } : {}
    const workspace: FileRoot = {
        id: 'workspace',
        label: 'Workspace',
        path: mountPath,
        writable: true,
        ...(ctx.workspaceTransport ? { transport: ctx.workspaceTransport } : {}),
        ...podExec
    }
    const roots: FileRoot[] = [workspace]
    const home = runtime === 'k8s' ? K8S_HOME_BASE : ctx.homeDir
    const configHome = frameworkCapability(framework).configHome
    if (configHome && home)
        roots.push({
            id: configHome.rootId,
            label: configHome.label,
            path: `${home}/${configHome.subdir}`,
            writable: true,
            ...podExec
        })
    if (runtime === 'k8s') roots.push(homeRoot(K8S_HOME_BASE, 'pod-exec'))
    else if (runtime === 'daemon') {
        // daemon: do NOT expose generic home — only workspace + framework-config roots
    } else if (ctx.homeDir) roots.push(homeRoot(ctx.homeDir))
    return roots
}

export const expectedRootIds = (ctx: {
    framework: AgentFramework
    runtime: AgentRuntime
    homeKnown: boolean
}): string[] => {
    if (ctx.runtime === 'external') return []
    const ids: string[] = ['workspace']
    if (ctx.homeKnown || ctx.runtime === 'k8s') {
        const configHome = frameworkCapability(ctx.framework).configHome
        if (configHome) ids.push(configHome.rootId)
        if (ctx.runtime !== 'daemon') ids.push(HOME_ROOT_ID)
    }
    return ids
}

export const defaultFileRoot = (mountPath: string): FileRoot => ({
    id: 'workspace',
    label: 'Workspace',
    path: mountPath,
    writable: true
})
