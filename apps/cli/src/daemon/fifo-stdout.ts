import { execFileSync } from 'node:child_process'
import {
    closeSync,
    constants,
    createReadStream,
    mkdtempSync,
    openSync,
    rmSync,
    type ReadStream
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A child's stdout as a FIFO instead of the runtime's socket. Bun (the
// compiled `mf`) hands a child a socketpair whose own end it has shut for
// writing, so the child's stdout reads as EOF at once. CPython's asyncio takes
// that for its reader having closed the pipe and closes its stdout transport,
// so an ACP agent built on it never answers. A FIFO's write end reports no
// such thing, under Bun and Node alike.
// Seen on a kind cloud computer [2026-09-25]: hermes 2026.9.24 spawned by mf
// 4.5.0 (Bun 1.3.9) never answered ACP initialize; spawned by Node, it did in
// 0.4 s.
export interface FifoStdout {
    // For the child's stdio; close it once the child is spawned.
    fd: number
    stream: ReadStream
}

export const fifoStdout = (): FifoStdout | null => {
    if (process.platform === 'win32') return null
    const dir = mkdtempSync(join(tmpdir(), 'mf-stdout-'))
    try {
        const path = join(dir, 'stdout')
        execFileSync('mkfifo', ['-m', '600', path])
        // A read-write holder lets both one-way opens return at once and
        // leaves the read end blocking, which the stream's reads need.
        const holder = openSync(path, constants.O_RDWR)
        const fd = openSync(path, constants.O_WRONLY)
        const readFd = openSync(path, constants.O_RDONLY)
        closeSync(holder)
        return { fd, stream: createReadStream('', { fd: readFd }) }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}
