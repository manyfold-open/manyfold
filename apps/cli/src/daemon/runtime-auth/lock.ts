import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Cross-process profile lock: a directory created with mkdir (atomic on every
// filesystem we run on) holding an owner record. A Node Map would only fence
// one daemon process; this fences a login PTY, a logout and a later exec
// helper against each other. A holder whose pid is gone, or whose record is
// older than the stale window, may be taken over.

const STALE_MS = 6 * 3600 * 1000

interface LockOwner {
    pid: number
    label: string
    acquiredAt: string
}

const pidAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0)
        return true
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
}

export class ProfileBusyError extends Error {
    readonly code = 'auth_profile_busy'
    constructor(readonly holder: LockOwner | null) {
        super(
            holder
                ? `profile is busy (${holder.label}, pid ${holder.pid})`
                : 'profile is busy'
        )
    }
}

export interface ProfileLock {
    release(): Promise<void>
}

export const acquireProfileLock = async (
    lockDir: string,
    label: string
): Promise<ProfileLock> => {
    const ownerPath = join(lockDir, 'owner.json')
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await mkdir(lockDir, { mode: 0o700 })
            const owner: LockOwner = {
                pid: process.pid,
                label,
                acquiredAt: new Date().toISOString()
            }
            await writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 })
            return {
                release: async () => {
                    await rm(lockDir, { recursive: true, force: true })
                }
            }
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
            let holder: LockOwner | null = null
            try {
                holder = JSON.parse(await readFile(ownerPath, 'utf8')) as LockOwner
            } catch {
                holder = null
            }
            const stale =
                !holder ||
                !pidAlive(holder.pid) ||
                Date.now() - Date.parse(holder.acquiredAt) > STALE_MS
            if (!stale || attempt === 1) throw new ProfileBusyError(holder)
            await rm(lockDir, { recursive: true, force: true })
        }
    }
    throw new ProfileBusyError(null)
}
