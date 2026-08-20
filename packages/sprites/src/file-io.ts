import { execSprite } from './exec'
import { execSpriteStream } from './exec-stream'
import { SpritesError } from './errors'
import { containmentPrelude, isContainmentExit } from './containment'
import type { SpritesClient } from './client'
import type { SpritesLogger } from './types'

const DEFAULT_WRITE_TIMEOUT_MS = 5 * 60_000
const DEFAULT_READ_TIMEOUT_MS = 2 * 60_000
const DEFAULT_STAT_TIMEOUT_MS = 15_000
const DEFAULT_TEMP_CLEANUP_TIMEOUT_MS = 15_000
const READ_CHUNK_BYTES = 65_536
const READ_CONCURRENCY = 1

export interface SpriteWriteFileArgs {
    absPath: string
    body: Buffer | AsyncIterable<Buffer>
    mode?: string
    timeoutMs?: number
    // when set, the write refuses paths that resolve outside this root
    containRoot?: string
}

export interface SpriteReadFileResult {
    stream: AsyncIterable<Buffer>
    size: number
    contentType: string
    done: Promise<void>
}

const shellEscape = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

// The write lands in a sibling temp file and is renamed, so a transfer that dies
// leaves the destination alone. The trap covers the failures the shell survives
// long enough to handle (a refused containment check, a failing `cat`); it does
// NOT cover a cancelled upload, because tearing down the exec session kills this
// shell too hard for an EXIT trap to run — verified against a real sprite. That
// case is cleaned up by the caller instead, which is why both layers exist.
export const buildWriteScript = (args: {
    absPath: string
    mode?: string
    containRoot?: string
}): string => {
    const q = shellEscape(args.absPath)
    const qPart = shellEscape(`${args.absPath}.mf-part`)
    const chmod = args.mode ? `chmod ${args.mode} ${q} && ` : ''
    return [
        'set -eu',
        'umask 077',
        // the temp path reaches the trap through this variable: quoting it
        // directly inside the trap's single-quoted handler re-splits paths with
        // whitespace into bogus signal names (macOS screenshot names did this)
        `__mf_part=${qPart}`,
        `mkdir -p "$(dirname ${q})"`,
        `trap 'rm -f -- "$__mf_part"' EXIT INT TERM HUP PIPE`,
        ...(args.containRoot
            ? [containmentPrelude(args.containRoot, [args.absPath])]
            : []),
        `cat > "$__mf_part"`,
        `mv -f -- "$__mf_part" ${q}`,
        `${chmod}echo ok`
    ].join('\n')
}

export const writeTempPath = (absPath: string): string => `${absPath}.mf-part`

// Indirection so tests can drive the write path's exec calls. The wiring between
// "write failed" and "temp file discarded" is what regressed twice (an in-shell
// trap looked right and did nothing against a real sprite), so it is worth having
// under test rather than only reasoned about.
export const writeExec = { execSprite }

// Best-effort: a cancelled upload leaves the temp file behind because the exec
// session is gone, so this is a fresh exec on the failure path only. It must not
// mask the original failure, and it is fine for it to fail too (the sprite may be
// unreachable, which is often why the write failed).
const discardTempFile = async (
    client: SpritesClient,
    spriteName: string,
    absPath: string,
    logger?: SpritesLogger
): Promise<void> => {
    try {
        await writeExec.execSprite(
            client,
            spriteName,
            {
                cmd: [
                    'bash',
                    '-c',
                    `rm -f ${shellEscape(writeTempPath(absPath))}`
                ],
                stdin: '',
                timeoutMs: DEFAULT_TEMP_CLEANUP_TIMEOUT_MS
            },
            logger
        )
    } catch (err) {
        logger?.warn(
            `spriteWriteFile temp cleanup failed for ${absPath}: ${(err as Error).message}`
        )
    }
}

export const spriteWriteFile = async (
    client: SpritesClient,
    spriteName: string,
    args: SpriteWriteFileArgs,
    logger?: SpritesLogger
): Promise<void> => {
    const script = buildWriteScript(args)

    let result
    try {
        result = await writeExec.execSprite(
            client,
            spriteName,
            {
                cmd: ['bash', '-c', script],
                stdin: args.body,
                timeoutMs: args.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS
            },
            logger
        )
    } catch (err) {
        await discardTempFile(client, spriteName, args.absPath, logger)
        throw err
    }
    if (result.exitCode !== 0) {
        await discardTempFile(client, spriteName, args.absPath, logger)
        // a containment refusal can never succeed on retry, so it must not be
        // reported as the runtime being temporarily unavailable
        if (isContainmentExit(result.exitCode))
            throw new SpritesError(
                'permanent',
                `path escapes file root: ${args.absPath}`
            )
        throw new SpritesError(
            'transient',
            `spriteWriteFile exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
        )
    }
}

// `stat` and `file` describe the link itself unless told to follow it, so a
// symlink reported its target path's length as the file size. The read path then
// asked for that many bytes and short-read, which failed the whole download: an
// in-root symlink — the kind framework config directories use — was unreadable
// through the files API. `-L` makes both describe what the link points at.
export const buildStatScript = (args: {
    absPath: string
    containRoot?: string
}): string => {
    const q = shellEscape(args.absPath)
    const guard = args.containRoot
        ? `${containmentPrelude(args.containRoot, [args.absPath])}\n`
        : ''
    // GNU form first, BSD second (the same pair the pod-exec client uses), so the
    // script runs on whatever image the runtime happens to be. The `-e` test
    // follows the link, which is what makes a dangling symlink read as missing
    // rather than as the link's own size — BSD's stat -L reports that instead of
    // failing.
    const size = `stat -Lc '%s' ${q} 2>/dev/null || stat -Lf '%z' ${q} 2>/dev/null`
    const missing = '{ echo MISSING; exit 0; }'
    return `${guard}if [ ! -e ${q} ]; then ${missing}; fi; ${size} || ${missing}; (file -L --mime-type -b ${q} 2>/dev/null || echo application/octet-stream)`
}

export const spriteStatFile = async (
    client: SpritesClient,
    spriteName: string,
    absPath: string,
    logger?: SpritesLogger,
    containRoot?: string
): Promise<{ size: number; contentType: string } | null> => {
    const script = buildStatScript({ absPath, containRoot })
    const result = await execSprite(
        client,
        spriteName,
        {
            cmd: ['bash', '-c', script],
            stdin: '',
            timeoutMs: DEFAULT_STAT_TIMEOUT_MS
        },
        logger
    )
    if (isContainmentExit(result.exitCode))
        throw new SpritesError(
            'permanent',
            `path escapes file root: ${absPath}`
        )
    if (result.exitCode !== 0) return null
    const lines = result.stdout.split(/\r?\n/).filter((l) => l.length > 0)
    if (lines.length === 0 || lines[0] === 'MISSING') return null
    const size = Number.parseInt(lines[0], 10)
    const contentType = lines[1]?.trim() || 'application/octet-stream'
    if (!Number.isFinite(size)) return null
    return { size, contentType }
}

export const spriteReadFile = async (
    client: SpritesClient,
    spriteName: string,
    absPath: string,
    logger?: SpritesLogger,
    timeoutMs?: number,
    // ADR-0013: the chunked read is many `dd` execs, so containment is checked by
    // the stat that gates them rather than inside each chunk — a wider window
    // than the single-command transports, recorded rather than hidden
    containRoot?: string
): Promise<SpriteReadFileResult | null> => {
    const stat = await spriteStatFile(
        client,
        spriteName,
        absPath,
        logger,
        containRoot
    )
    if (!stat) return null
    const perChunkTimeout = timeoutMs ?? DEFAULT_READ_TIMEOUT_MS

    let streamResolvedDone!: () => void
    let streamRejectedDone!: (err: Error) => void
    const done = new Promise<void>((resolve, reject) => {
        streamResolvedDone = resolve
        streamRejectedDone = reject
    })

    const stream: AsyncIterable<Buffer> = {
        [Symbol.asyncIterator]: async function* (): AsyncGenerator<Buffer> {
            const totalChunks = Math.max(
                1,
                Math.ceil(stat.size / READ_CHUNK_BYTES)
            )
            try {
                for (
                    let base = 0;
                    base < totalChunks;
                    base += READ_CONCURRENCY
                ) {
                    const batch: Array<Promise<Buffer>> = []
                    const end = Math.min(base + READ_CONCURRENCY, totalChunks)
                    for (let i = base; i < end; i++) {
                        const isTrailingChunk = i === totalChunks - 1
                        const expectedSize = isTrailingChunk
                            ? stat.size - i * READ_CHUNK_BYTES
                            : READ_CHUNK_BYTES
                        batch.push(
                            readChunk(
                                client,
                                spriteName,
                                absPath,
                                i,
                                expectedSize,
                                isTrailingChunk,
                                perChunkTimeout,
                                logger
                            )
                        )
                    }
                    const results = await Promise.all(batch)
                    for (const buf of results) if (buf.length > 0) yield buf
                }
                streamResolvedDone()
            } catch (err) {
                const asError =
                    err instanceof Error
                        ? err
                        : new Error(`spriteReadFile failed: ${String(err)}`)
                streamRejectedDone(asError)
                throw asError
            }
        }
    }

    return {
        stream,
        size: stat.size,
        contentType: stat.contentType,
        done
    }
}

const readChunk = async (
    client: SpritesClient,
    spriteName: string,
    absPath: string,
    chunkIndex: number,
    expectedSize: number,
    isTrailingChunk: boolean,
    timeoutMs: number,
    logger?: SpritesLogger
): Promise<Buffer> => {
    const maxAttempts = 5
    let lastErr: Error | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const handle = execSpriteStream(
            client,
            spriteName,
            {
                cmd: [
                    'dd',
                    `if=${absPath}`,
                    `bs=${READ_CHUNK_BYTES}`,
                    'count=1',
                    `skip=${chunkIndex}`,
                    'iflag=fullblock',
                    'status=none'
                ],
                stdin: '',
                binary: true,
                timeoutMs
            },
            logger
        )
        const parts: Buffer[] = []
        try {
            for await (const text of handle.stdout) {
                if (text) parts.push(Buffer.from(text, 'latin1'))
            }
            const result = await handle.result
            if (result.exitCode !== 0) {
                lastErr = new SpritesError(
                    'transient',
                    `readChunk ${chunkIndex} exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
                )
            } else {
                const got = Buffer.concat(parts)
                if (got.length === expectedSize) return got
                // A concurrent writer can append to the file between the initial
                // stat and this read (turn adoption reads a transcript the agent
                // may still be writing), so the chunk the stat marked as trailing
                // now holds more than the stat-derived remainder. Accept the
                // growth and return the planned prefix — keeping the stream's
                // total bytes equal to the reported size. Only the trailing chunk
                // can grow: interior chunk boundaries sit within the stat size and
                // a full 64KB block is read regardless. A genuine short read
                // (fewer bytes than planned → truncation/corruption) still fails.
                if (isTrailingChunk && got.length > expectedSize)
                    return got.subarray(0, expectedSize)
                lastErr = new SpritesError(
                    'transient',
                    `readChunk ${chunkIndex} short read ${got.length}/${expectedSize}`
                )
            }
        } catch (err) {
            lastErr = err instanceof Error ? err : new Error(String(err))
        }
        await new Promise((r) => setTimeout(r, 200 * attempt))
    }
    throw (
        lastErr ??
        new SpritesError('transient', `readChunk ${chunkIndex} unknown failure`)
    )
}
