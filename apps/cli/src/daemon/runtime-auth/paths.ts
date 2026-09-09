import { homedir } from 'node:os'
import { join } from 'node:path'
import {
    isObjectId,
    isRuntimeAuthOperationId,
    isRuntimeAuthProfileId,
    runtimeAuthRoot,
    type ConfigurableFramework
} from '@manyfold/shared'
import { resolveConfigDir } from '@/config'
import { codexHomeDir, type FrameworkConfigDirs } from '../inspect-fs'

// Host-local layout for runtime auth profiles. Every path is derived here
// from ids the API sends; an id that does not parse never reaches the
// filesystem, which is what makes "no path travels over the wire" hold.
//
//   <configRoot>/runtime-auth/<daemonId>/<runtimeId>/
//       profiles/<profileId>/metadata.json   safe metadata + generation
//       profiles/<profileId>/view/           the credential context (D1)
//       profiles/<profileId>/lock/           cross-process lock dir
//       operations/<operationId>.json        secret-free journal
//
// `daemonId` is the registration id (dh_…), so two control planes sharing a
// machine keep separate stores even under the same profile name.

export interface RuntimeAuthScope {
    daemonId: string
    runtimeId: string
}

export const assertProfileId = (value: unknown): string => {
    if (!isRuntimeAuthProfileId(value))
        throw new Error('invalid runtime auth profile id')
    return value
}

export const assertOperationId = (value: unknown): string => {
    if (!isRuntimeAuthOperationId(value))
        throw new Error('invalid runtime auth operation id')
    return value
}

const assertScope = (scope: RuntimeAuthScope): RuntimeAuthScope => {
    if (!isObjectId(scope.daemonId, 'daemonHost'))
        throw new Error('invalid daemon id for runtime auth scope')
    if (!isObjectId(scope.runtimeId, 'agentRuntime'))
        throw new Error('invalid runtime id for runtime auth scope')
    return scope
}

export const authRoot = (): string => runtimeAuthRoot(resolveConfigDir())

export const scopeDir = (scope: RuntimeAuthScope): string => {
    assertScope(scope)
    return join(authRoot(), scope.daemonId, scope.runtimeId)
}

export const profilesDir = (scope: RuntimeAuthScope): string =>
    join(scopeDir(scope), 'profiles')

export const operationsDir = (scope: RuntimeAuthScope): string =>
    join(scopeDir(scope), 'operations')

export interface ProfilePaths {
    dir: string
    metadataPath: string
    viewDir: string
    lockDir: string
}

export const profilePaths = (
    scope: RuntimeAuthScope,
    profileId: string
): ProfilePaths => {
    const dir = join(profilesDir(scope), assertProfileId(profileId))
    return {
        dir,
        metadataPath: join(dir, 'metadata.json'),
        viewDir: join(dir, 'view'),
        lockDir: join(dir, 'lock')
    }
}

export const operationPath = (
    scope: RuntimeAuthScope,
    operationId: string
): string =>
    join(operationsDir(scope), `${assertOperationId(operationId)}.json`)

// The framework dirs a profile view stands in for. The view IS the config
// dir for claude/codex and the HOME for gemini (which appends .gemini).
export const viewConfigDirs = (
    framework: ConfigurableFramework,
    viewDir: string
): FrameworkConfigDirs => {
    const native = nativeDirsFor()
    if (framework === 'claude-code')
        return {
            ...native,
            claudeDir: viewDir,
            claudeJson: join(viewDir, '.claude.json'),
            envAuth: false
        }
    if (framework === 'codex')
        return { ...native, codexHome: viewDir, envAuth: false }
    return { ...native, geminiDir: join(viewDir, '.gemini'), envAuth: false }
}

export const nativeDirsFor = (): FrameworkConfigDirs => ({
    claudeDir: join(homedir(), '.claude'),
    claudeJson: join(homedir(), '.claude.json'),
    codexHome: codexHomeDir(),
    geminiDir: join(homedir(), '.gemini'),
    envAuth: true
})
