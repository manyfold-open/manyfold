import { createHash, randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import {
    chmod,
    lstat,
    mkdir,
    open,
    readFile,
    realpath,
    rm,
    writeFile
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { DaemonConfigCommit } from '@manyfold/shared'
import { readJsonState, writeProtectedJson } from '@/json-state'
import { acquireProcessLock, ProcessLockBusyError } from './process-lock'
import type { RpcContext } from './ws-client'

const digest = (bytes: string | Buffer): string =>
    createHash('sha256').update(bytes).digest('hex')
const hashFile = async (path: string): Promise<string | null> => {
    try {
        return digest(await readFile(path))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
    }
}
const generationValid = (value: unknown): value is string =>
    typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)
const hashValid = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

const contract = (value: unknown): DaemonConfigCommit => {
    const entry = value as Partial<DaemonConfigCommit> | null
    if (
        !entry ||
        !generationValid(entry.generation) ||
        !hashValid(entry.revision) ||
        (entry.expectedSha256 !== null && !hashValid(entry.expectedSha256))
    )
        throw new Error('config_commit_invalid')
    return entry as DaemonConfigCommit
}

const noSymlink = async (path: string): Promise<void> => {
    try {
        if ((await lstat(path)).isSymbolicLink())
            throw new Error('config_commit_symlink')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
}

// State lives beside the authorized target so multiple daemon processes and
// profiles use the same kernel lock. It contains only generations and hashes.
export const commitConfigFile = async (input: {
    path: string
    content: string | null
    commit: unknown
    ctx: RpcContext
    validatePath: () => string
}): Promise<'delivered' | 'unchanged'> => {
    const commit = contract(input.commit)
    if (input.content === null && commit.expectedSha256 !== null)
        throw new Error('config_commit_invalid')
    let cancelled = false
    input.ctx.onCancel(() => {
        cancelled = true
    })
    const assertCurrent = () => {
        if (cancelled || !input.ctx.isCurrentConnection?.())
            throw new Error('config_commit_cancelled')
    }
    assertCurrent()
    await mkdir(dirname(input.path), { recursive: true })
    input.validatePath()
    const parent = await realpath(dirname(input.path))
    const target = join(parent, basename(input.path))
    const sidecar = join(parent, '.manyfold-config-delivery')
    // Config names also share ownership on case-insensitive/normalizing volumes.
    const stateDir = join(
        sidecar,
        digest(basename(target).normalize('NFC').toLowerCase())
    )
    for (const directory of [sidecar, stateDir]) {
        await noSymlink(directory)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await noSymlink(directory)
        await chmod(directory, 0o700)
    }
    const statePath = join(stateDir, 'state.json')
    const contentSha256 = input.content === null ? null : digest(input.content)
    const sameGeneration = (state: Record<string, unknown>) =>
        state.generation === commit.generation &&
        state.revision === commit.revision &&
        state.contentSha256 === contentSha256
    const withLock = async <T>(
        work: (state: Record<string, unknown> | undefined) => Promise<T>
    ): Promise<T> => {
        let lock: Awaited<ReturnType<typeof acquireProcessLock>> | undefined
        const deadline = Date.now() + 2000
        while (!lock) {
            assertCurrent()
            await noSymlink(join(stateDir, 'lock'))
            try {
                lock = await acquireProcessLock(stateDir)
            } catch (error) {
                if (
                    !(error instanceof ProcessLockBusyError) ||
                    Date.now() >= deadline
                )
                    throw new Error('config_commit_busy')
                await new Promise((resolve) => setTimeout(resolve, 20))
            }
        }
        try {
            assertCurrent()
            input.validatePath()
            if ((await realpath(dirname(input.path))) !== parent)
                throw new Error('config_commit_path_changed')
            await noSymlink(target)
            await noSymlink(sidecar)
            await noSymlink(stateDir)
            await noSymlink(statePath)
            const value = await readJsonState(statePath)
            if (
                value !== undefined &&
                (value === null ||
                    typeof value !== 'object' ||
                    Array.isArray(value))
            )
                throw new Error('config_commit_state_invalid')
            const state = value as Record<string, unknown> | undefined
            if (
                state !== undefined &&
                (!generationValid(state.generation) ||
                    !hashValid(state.revision) ||
                    (state.contentSha256 !== null &&
                        !hashValid(state.contentSha256)))
            )
                throw new Error('config_commit_state_invalid')
            return await work(state)
        } finally {
            await lock.release()
        }
    }
    await withLock(async (state) => {
        if (
            state &&
            BigInt(String(state.generation)) > BigInt(commit.generation)
        )
            throw new Error('config_commit_superseded')
        if (state?.generation === commit.generation && !sameGeneration(state))
            throw new Error('config_commit_generation_conflict')
        if (!state || !sameGeneration(state))
            await writeProtectedJson(statePath, {
                generation: commit.generation,
                revision: commit.revision,
                contentSha256
            })
    })
    const temporary = join(
        parent,
        `.${basename(target)}.mf-config-${randomUUID()}.tmp`
    )
    try {
        if (input.content !== null) {
            await writeFile(temporary, input.content, {
                flag: 'wx',
                mode: 0o600
            })
            const file = await open(temporary, 'r')
            try {
                await file.sync()
            } finally {
                await file.close()
            }
        }
        return await withLock(async (state) => {
            if (!state || !sameGeneration(state))
                throw new Error('config_commit_superseded')
            const currentHash = await hashFile(target)
            assertCurrent()
            input.validatePath()
            if (currentHash === contentSha256) {
                if (currentHash !== null) await chmod(target, 0o600)
                return 'unchanged'
            }
            if (currentHash !== commit.expectedSha256)
                throw new Error('config_commit_content_changed')
            if (input.content === null)
                throw new Error('config_commit_content_changed')
            // The short cross-process lock excludes new admission, and the
            // synchronous rename has no cancellation gap after the last check.
            renameSync(temporary, target)
            return 'delivered'
        })
    } finally {
        await rm(temporary, { force: true }).catch(() => {})
    }
}
