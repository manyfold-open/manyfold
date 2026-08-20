import { execSprite, spriteReadFile } from '@manyfold/sprites'
import type { SpritesClient, SpritesLogger } from '@manyfold/sprites'
import type { PodExec } from '@/modules/k8s/pod-exec'
import type { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'

const LOCATE_TIMEOUT_MS = 30_000
const READ_TIMEOUT_MS = 120_000
const SPRITE_FILE_READ_TIMEOUT_MS = 60_000
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

const decodeBase64Stream = (stdout: string): Buffer => {
    const cleaned = stdout.replace(/\s+/g, '')
    return Buffer.from(cleaned, 'base64')
}

const buildBinaryReadScript = (absPath: string): string => {
    const escaped = shellEscape(absPath)
    return [
        `if [ ! -f ${escaped} ]; then exit 2; fi`,
        `size=$(stat -c %s ${escaped} 2>/dev/null || stat -f %z ${escaped})`,
        `if [ "$size" -gt ${BINARY_READ_MAX_BYTES} ]; then exit 3; fi`,
        `base64 -w0 < ${escaped} 2>/dev/null || base64 < ${escaped}`
    ].join('; ')
}

const buildTextReadScript = (absPath: string): string => {
    const escaped = shellEscape(absPath)
    return [
        `if [ ! -f ${escaped} ]; then exit 2; fi`,
        `size=$(stat -c %s ${escaped} 2>/dev/null || stat -f %z ${escaped})`,
        `if [ "$size" -gt ${TEXT_READ_MAX_BYTES} ]; then exit 3; fi`,
        `cat ${escaped}`
    ].join('; ')
}

export class SpriteRecoveryFs implements RecoveryFs {
    constructor(
        private readonly client: SpritesClient,
        private readonly spriteName: string,
        private readonly logger?: SpritesLogger
    ) {}

    async locate(bashScript: string): Promise<string | null> {
        const result = await execSprite(
            this.client,
            this.spriteName,
            {
                cmd: ['bash', '-lc', bashScript],
                stdin: '',
                timeoutMs: LOCATE_TIMEOUT_MS
            },
            this.logger
        )
        if (result.exitCode !== 0) return null
        const path = result.stdout
            .split(/\r?\n/)
            .find((l) => l.trim().length > 0)
        return path?.trim() ?? null
    }

    async listFiles(bashScript: string): Promise<string[]> {
        const result = await execSprite(
            this.client,
            this.spriteName,
            {
                cmd: ['bash', '-lc', bashScript],
                stdin: '',
                timeoutMs: LOCATE_TIMEOUT_MS
            },
            this.logger
        )
        if (result.exitCode !== 0) return []
        return result.stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
    }

    async exec(bashScript: string): Promise<string | null> {
        const result = await execSprite(
            this.client,
            this.spriteName,
            {
                cmd: ['bash', '-lc', bashScript],
                stdin: '',
                timeoutMs: SCAN_TIMEOUT_MS
            },
            this.logger
        )
        if (result.exitCode !== 0) return null
        return result.stdout
    }

    async readFile(absPath: string): Promise<string | null> {
        const handle = await spriteReadFile(
            this.client,
            this.spriteName,
            absPath,
            this.logger,
            SPRITE_FILE_READ_TIMEOUT_MS
        )
        if (!handle) return null
        if (handle.size > TEXT_READ_MAX_BYTES)
            throw readSizeExceededError(absPath, TEXT_READ_MAX_BYTES)
        const chunks: Buffer[] = []
        for await (const chunk of handle.stream) chunks.push(chunk)
        return Buffer.concat(chunks).toString('utf8')
    }

    async readBinary(absPath: string): Promise<Buffer | null> {
        const result = await execSprite(
            this.client,
            this.spriteName,
            {
                cmd: ['bash', '-lc', buildBinaryReadScript(absPath)],
                stdin: '',
                timeoutMs: BINARY_READ_TIMEOUT_MS
            },
            this.logger
        )
        if (result.exitCode === 2) return null
        if (result.exitCode === 3)
            throw new Error(`${absPath} exceeds ${BINARY_READ_MAX_BYTES} bytes`)
        if (result.exitCode !== 0)
            throw new Error(
                `sprite base64 ${absPath} exited ${result.exitCode}: ${result.stderr.slice(0, 256)}`
            )
        return decodeBase64Stream(result.stdout)
    }
}

export class K8sRecoveryFs implements RecoveryFs {
    constructor(private readonly podExec: PodExec) {}

    async locate(bashScript: string): Promise<string | null> {
        const result = await this.podExec.run({
            cmd: ['bash', '-lc', bashScript],
            timeoutMs: LOCATE_TIMEOUT_MS
        })
        if (result.exitCode !== 0) return null
        const path = result.stdout
            .split(/\r?\n/)
            .find((l) => l.trim().length > 0)
        return path?.trim() ?? null
    }

    async listFiles(bashScript: string): Promise<string[]> {
        const result = await this.podExec.run({
            cmd: ['bash', '-lc', bashScript],
            timeoutMs: LOCATE_TIMEOUT_MS
        })
        if (result.exitCode !== 0) return []
        return result.stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
    }

    async exec(bashScript: string): Promise<string | null> {
        const result = await this.podExec.run({
            cmd: ['bash', '-lc', bashScript],
            timeoutMs: SCAN_TIMEOUT_MS
        })
        if (result.exitCode !== 0) return null
        return result.stdout
    }

    async readFile(absPath: string): Promise<string | null> {
        const result = await this.podExec.run({
            cmd: ['bash', '-lc', buildTextReadScript(absPath)],
            timeoutMs: READ_TIMEOUT_MS
        })
        if (result.exitCode === 2) return null
        if (result.exitCode === 3)
            throw readSizeExceededError(absPath, TEXT_READ_MAX_BYTES)
        if (result.exitCode !== 0)
            throw new Error(
                `pod cat ${absPath} exited ${result.exitCode}: ${result.stderr.slice(0, 256)}`
            )
        return result.stdout
    }

    async readBinary(absPath: string): Promise<Buffer | null> {
        const result = await this.podExec.run({
            cmd: ['bash', '-lc', buildBinaryReadScript(absPath)],
            timeoutMs: BINARY_READ_TIMEOUT_MS
        })
        if (result.exitCode === 2) return null
        if (result.exitCode === 3)
            throw new Error(`${absPath} exceeds ${BINARY_READ_MAX_BYTES} bytes`)
        if (result.exitCode !== 0)
            throw new Error(
                `pod base64 ${absPath} exited ${result.exitCode}: ${result.stderr.slice(0, 256)}`
            )
        return decodeBase64Stream(result.stdout)
    }
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
        private readonly daemonId: string
    ) {}

    async locate(bashScript: string): Promise<string | null> {
        const result = await runDaemonBash(
            this.registry,
            this.daemonId,
            bashScript,
            LOCATE_TIMEOUT_MS
        )
        if (result.exitCode !== 0) return null
        const path = result.stdout
            .split(/\r?\n/)
            .find((l) => l.trim().length > 0)
        return path?.trim() ?? null
    }

    async listFiles(bashScript: string): Promise<string[]> {
        const result = await runDaemonBash(
            this.registry,
            this.daemonId,
            bashScript,
            LOCATE_TIMEOUT_MS
        )
        if (result.exitCode !== 0) return []
        return result.stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
    }

    async exec(bashScript: string): Promise<string | null> {
        const result = await runDaemonBash(
            this.registry,
            this.daemonId,
            bashScript,
            SCAN_TIMEOUT_MS
        )
        if (result.exitCode !== 0) return null
        return result.stdout
    }

    async readFile(absPath: string): Promise<string | null> {
        const buf = await readDaemonFile(
            this.registry,
            this.daemonId,
            absPath,
            TEXT_READ_MAX_BYTES
        )
        if (!buf) return null
        return buf.toString('utf8')
    }

    async readBinary(absPath: string): Promise<Buffer | null> {
        return readDaemonFile(
            this.registry,
            this.daemonId,
            absPath,
            BINARY_READ_MAX_BYTES
        )
    }
}
