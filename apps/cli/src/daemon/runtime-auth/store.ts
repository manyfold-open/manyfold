import { readdir, rm } from 'node:fs/promises'
import type {
    ConfigurableFramework,
    DaemonAuthOperationRecord,
    RuntimeAuthMethod,
    RuntimeAuthOperationKind,
    RuntimeAuthOperationStatus
} from '@manyfold/shared'
import { readJsonState, writeProtectedJson } from '@/json-state'
import {
    operationPath,
    profilePaths,
    profilesDir,
    type RuntimeAuthScope
} from './paths'

// Safe metadata beside the view. Never holds a token; `generation` is the
// opaque counter the API keys caches on.
export interface ProfileMetadata {
    profileId: string
    framework: ConfigurableFramework
    authMethod: RuntimeAuthMethod
    generation: number
    createdAt: string
    lastLoginAt: string | null
    lastLogoutAt: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const readMetadata = async (
    scope: RuntimeAuthScope,
    profileId: string
): Promise<ProfileMetadata | null> => {
    const raw = await readJsonState(profilePaths(scope, profileId).metadataPath)
    if (!isRecord(raw)) return null
    if (raw.profileId !== profileId) return null
    return {
        profileId,
        framework: raw.framework as ConfigurableFramework,
        authMethod: raw.authMethod === 'api-key' ? 'api-key' : 'subscription',
        generation: typeof raw.generation === 'number' ? raw.generation : 0,
        createdAt:
            typeof raw.createdAt === 'string'
                ? raw.createdAt
                : new Date(0).toISOString(),
        lastLoginAt:
            typeof raw.lastLoginAt === 'string' ? raw.lastLoginAt : null,
        lastLogoutAt:
            typeof raw.lastLogoutAt === 'string' ? raw.lastLogoutAt : null
    }
}

export const writeMetadata = async (
    scope: RuntimeAuthScope,
    metadata: ProfileMetadata
): Promise<void> =>
    writeProtectedJson(
        profilePaths(scope, metadata.profileId).metadataPath,
        metadata
    )

export const listProfileIds = async (
    scope: RuntimeAuthScope
): Promise<string[]> => {
    try {
        const entries = await readdir(profilesDir(scope), {
            withFileTypes: true
        })
        return entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort()
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
    }
}

// Removes the profile directory. `rm` unlinks symlinks rather than following
// them, so the shared session/config targets the view points at survive.
export const removeProfileDir = async (
    scope: RuntimeAuthScope,
    profileId: string
): Promise<void> => {
    await rm(profilePaths(scope, profileId).dir, {
        recursive: true,
        force: true
    })
}

export const writeOperation = async (
    scope: RuntimeAuthScope,
    record: DaemonAuthOperationRecord
): Promise<void> =>
    writeProtectedJson(operationPath(scope, record.operationId), record)

export const readOperation = async (
    scope: RuntimeAuthScope,
    operationId: string
): Promise<DaemonAuthOperationRecord | null> => {
    const raw = await readJsonState(operationPath(scope, operationId))
    if (!isRecord(raw) || raw.operationId !== operationId) return null
    return raw as unknown as DaemonAuthOperationRecord
}

export const startOperation = async (
    scope: RuntimeAuthScope,
    input: {
        operationId: string
        profileId: string
        kind: RuntimeAuthOperationKind
    }
): Promise<DaemonAuthOperationRecord> => {
    const now = new Date().toISOString()
    const record: DaemonAuthOperationRecord = {
        operationId: input.operationId,
        profileId: input.profileId,
        kind: input.kind,
        status: 'running',
        resultCode: null,
        error: null,
        startedAt: now,
        updatedAt: now
    }
    await writeOperation(scope, record)
    return record
}

export const finishOperation = async (
    scope: RuntimeAuthScope,
    record: DaemonAuthOperationRecord,
    outcome: {
        status: RuntimeAuthOperationStatus
        resultCode: string | null
        error: string | null
    }
): Promise<DaemonAuthOperationRecord> => {
    const next: DaemonAuthOperationRecord = {
        ...record,
        ...outcome,
        updatedAt: new Date().toISOString()
    }
    await writeOperation(scope, next)
    return next
}
