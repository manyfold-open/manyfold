import type { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import type { AwakeHold } from '@/modules/hosts/host-awake.service'

// A read from a machine that sleeps holds it for as long as the read runs,
// and nothing holds it between reads (ADR-0038); the release grace keeps
// back-to-back reads on one lease. A hold handed to the caller instead is one
// a caller can forget, and a forgotten hold is renewed until the API restarts.
// Seen on staging [2026-09-29]: four callers forgot it, and a sandbox read by
// a gemini automation every 2 h ran 14–20 h a day from 2026-09-20.
export const whileHeld = async <T>(
    hold: (() => AwakeHold) | undefined,
    work: () => Promise<T>
): Promise<T> => {
    const held = hold?.()
    try {
        return await work()
    } finally {
        void held?.release()
    }
}

const LOCATE_TIMEOUT_MS = 30_000
const BINARY_READ_TIMEOUT_MS = 90_000
const BINARY_READ_MAX_BYTES = 50 * 1024 * 1024
// Session transcripts are parsed into JS objects several times their raw size,
// so text reads get the same ceiling as binary ones instead of buffering
// whatever a runaway transcript has grown to.
export const TEXT_READ_MAX_BYTES = 50 * 1024 * 1024
const SCAN_TIMEOUT_MS = 60_000

export const shellEscape = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

export const readSizeExceededError = (absPath: string, max: number): Error =>
    new Error(`${absPath} exceeds ${max} bytes`)

export interface RecoveryFs {
    locate(bashScript: string): Promise<string | null>
    listFiles(bashScript: string): Promise<string[]>
    // Raw stdout of a bash script (null on non-zero exit) — for scan scripts
    // whose output is structured records, not one path per line.
    exec(bashScript: string): Promise<string | null>
    readFile(absPath: string): Promise<string | null>
    readBinary(absPath: string): Promise<Buffer | null>
}

interface DaemonExecResult {
    exitCode: number
    stdout: string
    stderr: string
}

const runDaemonBash = async (
    registry: DaemonRegistryService,
    daemonId: string,
    bashScript: string,
    timeoutMs: number
): Promise<DaemonExecResult> => {
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    const stream = registry.streamRpc({
        daemonId,
        method: 'exec.start',
        payload: {
            cmd: ['bash', '-lc', bashScript],
            env: {},
            timeoutMs
        },
        timeoutMs: timeoutMs + 5_000,
        onEvent: (kind, data) => {
            if (kind === 'stdout') stdoutChunks.push(data)
            else if (kind === 'stderr') stderrChunks.push(data)
        }
    })
    const payload = await stream.result
    return {
        exitCode: Number((payload as { exitCode?: number })?.exitCode ?? 0),
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join('')
    }
}

const readDaemonFile = async (
    registry: DaemonRegistryService,
    daemonId: string,
    absPath: string,
    maxBytes: number
): Promise<Buffer | null> => {
    const chunks: Buffer[] = []
    let received = 0
    let overLimit = false
    const stream = registry.streamRpc({
        daemonId,
        method: 'fs.read',
        payload: { path: absPath, chunked: true },
        timeoutMs: BINARY_READ_TIMEOUT_MS,
        onEvent: (kind, data) => {
            if (kind !== 'fs.chunk' || overLimit) return
            const chunk = Buffer.from(data, 'base64')
            received += chunk.length
            if (received > maxBytes) {
                overLimit = true
                stream.cancel()
                return
            }
            chunks.push(chunk)
        }
    })
    try {
        await stream.result
    } catch (err) {
        if (overLimit) throw readSizeExceededError(absPath, maxBytes)
        const msg = (err as Error).message
        if (/ENOENT|no such file/i.test(msg)) return null
        throw err
    }
    if (overLimit) throw readSizeExceededError(absPath, maxBytes)
    return Buffer.concat(chunks)
}

export class DaemonRecoveryFs implements RecoveryFs {
    constructor(
        private readonly registry: DaemonRegistryService,
        private readonly daemonId: string,
        // Absent for a machine that never sleeps.
        private readonly hold?: () => AwakeHold
    ) {}

    async locate(bashScript: string): Promise<string | null> {
        const result = await this.bash(bashScript, LOCATE_TIMEOUT_MS)
        if (result.exitCode !== 0) return null
        const path = result.stdout
            .split(/\r?\n/)
            .find((l) => l.trim().length > 0)
        return path?.trim() ?? null
    }

    async listFiles(bashScript: string): Promise<string[]> {
        const result = await this.bash(bashScript, LOCATE_TIMEOUT_MS)
        if (result.exitCode !== 0) return []
        return result.stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
    }

    async exec(bashScript: string): Promise<string | null> {
        const result = await this.bash(bashScript, SCAN_TIMEOUT_MS)
        if (result.exitCode !== 0) return null
        return result.stdout
    }

    async readFile(absPath: string): Promise<string | null> {
        const buf = await this.read(absPath, TEXT_READ_MAX_BYTES)
        if (!buf) return null
        return buf.toString('utf8')
    }

    async readBinary(absPath: string): Promise<Buffer | null> {
        return this.read(absPath, BINARY_READ_MAX_BYTES)
    }

    private bash(
        bashScript: string,
        timeoutMs: number
    ): Promise<DaemonExecResult> {
        return whileHeld(this.hold, () =>
            runDaemonBash(this.registry, this.daemonId, bashScript, timeoutMs)
        )
    }

    private read(absPath: string, maxBytes: number): Promise<Buffer | null> {
        return whileHeld(this.hold, () =>
            readDaemonFile(this.registry, this.daemonId, absPath, maxBytes)
        )
    }
}
