import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'

type TryLock = (fd: number) => boolean
let implementation: Promise<TryLock> | undefined

const loadTryLock = async (): Promise<TryLock> => {
    if (!process.versions.bun)
        return (await import('fs-native-extensions')).tryLock
    // Seen on Bun 1.3.9/Darwin: the addon calls an unsupported
    // uv_get_osfhandle shim. Use the same OS locks through Bun's FFI.
    const { dlopen, ptr, read } = await import('bun:ffi')
    const darwin = process.platform === 'darwin'
    if (
        !darwin &&
        (process.platform !== 'linux' ||
            !['x64', 'arm64'].includes(process.arch))
    )
        throw new Error('daemon file locking is unsupported on this platform')
    const errnoName = darwin ? '__error' : '__errno_location'
    const library = dlopen(
        darwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
        {
            [errnoName]: { args: [], returns: 'ptr' },
            fcntl: {
                args: darwin ? ['i32', 'i32'] : ['i32', 'i32', 'ptr'],
                returns: 'i32'
            },
            ...(darwin
                ? { flock: { args: ['i32', 'i32'], returns: 'i32' } as const }
                : {})
        }
    )
    // Match fs-native-extensions: BSD flock on Darwin, OFD record locks on
    // Linux. Linux LP64 struct flock is identical on supported x64/arm64.
    const record = Buffer.alloc(32)
    record.writeInt16LE(1, 0) // F_WRLCK; SEEK_SET, start, length and pid are zero.
    return (fd) => {
        const flags = darwin
            ? library.symbols.fcntl(fd, 1)
            : library.symbols.fcntl(fd, 1, 0)
        if (flags < 0 || !(flags & 1))
            throw new Error('daemon lock descriptor is not close-on-exec')
        for (let attempt = 0; attempt < 3; attempt++) {
            const result = darwin
                ? library.symbols.flock(fd, 6)
                : library.symbols.fcntl(fd, 37, ptr(record))
            if (result === 0) return true
            const errno = read.i32(library.symbols[errnoName]())
            if (errno === (darwin ? 35 : 11)) return false
            if (errno !== 4)
                throw new Error(`daemon file lock failed (errno=${errno})`)
        }
        throw new Error('daemon file lock was repeatedly interrupted')
    }
}

export const openFileLock = async (
    path: string
): Promise<FileHandle | null> => {
    const closeOnExec = process.platform === 'darwin' ? 0x01000000 : 0x80000
    const file = await open(
        path,
        constants.O_CREAT | constants.O_RDWR | closeOnExec,
        0o600
    )
    try {
        implementation ??= loadTryLock()
        if ((await implementation)(file.fd)) return file
        await file.close()
        return null
    } catch (err) {
        await file.close()
        throw err
    }
}
