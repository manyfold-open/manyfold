import type { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import type { DaemonConfigAttempt } from './daemon-config-delivery.service'
import { createHash } from 'node:crypto'

export const daemonConfigRpc = async (
    registry: DaemonRegistryService,
    daemonId: string,
    method: 'fs.read' | 'fs.write',
    payload: Record<string, unknown>,
    attempt: DaemonConfigAttempt
): Promise<Record<string, unknown> | undefined> => {
    await attempt.assertCurrent()
    const stream = registry.streamRpc({
        daemonId,
        method,
        payload,
        expectedConnection: attempt.expectedConnection,
        timeoutMs: 30_000,
        onEvent: undefined
    })
    const cancel = () => stream.cancel()
    attempt.signal.addEventListener('abort', cancel, { once: true })
    if (attempt.signal.aborted) cancel()
    try {
        const result = await stream.result
        await attempt.assertCurrent()
        return result
    } finally {
        attempt.signal.removeEventListener('abort', cancel)
    }
}

export const daemonConfigRead = async (
    registry: DaemonRegistryService,
    daemonId: string,
    path: string,
    attempt: DaemonConfigAttempt
): Promise<string | null> => {
    try {
        const result = await daemonConfigRpc(
            registry,
            daemonId,
            'fs.read',
            { path, chunked: false },
            attempt
        )
        if (typeof result?.content !== 'string')
            throw new Error('daemon configuration read invalid')
        return result.content
    } catch (error) {
        if (isMissingFileError(error)) return null
        throw error
    }
}

export const daemonConfigWrite = async (
    registry: DaemonRegistryService,
    daemonId: string,
    path: string,
    text: string | null,
    previous: string | null,
    revision: string,
    attempt: DaemonConfigAttempt
): Promise<'delivered' | 'unchanged'> => {
    const result = await daemonConfigRpc(
        registry,
        daemonId,
        'fs.write',
        {
            path,
            content: text,
            mode: '600',
            configCommit: {
                generation: attempt.generation,
                revision,
                expectedSha256:
                    previous === null
                        ? null
                        : createHash('sha256').update(previous).digest('hex')
            }
        },
        attempt
    )
    if (result?.status !== 'delivered' && result?.status !== 'unchanged')
        throw new Error('daemon configuration commit unsupported')
    return result.status
}

// Small-file and bash primitives over the daemon RPC, for services that
// materialize per-agent config onto a self-owned computer (#781) — the same
// shapes the skill materializer already drives, factored out so the MCP and
// context-doc paths don't hand-copy them.

export const runDaemonBash = async (
    registry: DaemonRegistryService,
    daemonId: string,
    script: string,
    timeoutMs: number,
    attempt?: DaemonConfigAttempt
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    await attempt?.assertCurrent()
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    const stream = registry.streamRpc({
        daemonId,
        method: 'exec.start',
        payload: {
            cmd: ['bash', '-lc', script],
            env: {},
            timeoutMs
        },
        timeoutMs: timeoutMs + 5_000,
        expectedConnection: attempt?.expectedConnection,
        onEvent: (kind, data) => {
            if (kind === 'stdout') stdoutChunks.push(data)
            else if (kind === 'stderr') stderrChunks.push(data)
        }
    })
    const cancel = () => stream.cancel()
    attempt?.signal.addEventListener('abort', cancel, { once: true })
    if (attempt?.signal.aborted) cancel()
    let payload: Record<string, unknown> | undefined
    try {
        payload = await stream.result
        await attempt?.assertCurrent()
    } finally {
        attempt?.signal.removeEventListener('abort', cancel)
    }
    return {
        exitCode: Number((payload as { exitCode?: number })?.exitCode ?? 0),
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join('')
    }
}

const isMissingFileError = (err: unknown): boolean =>
    /^(?:Error: )?ENOENT\b/.test((err as Error)?.message ?? '')

// Absent-is-null, matching the sprite readFileText contract every MCP
// read-modify-write relies on. Anything else (offline daemon, containment
// refusal) stays an error the caller must surface.
export const daemonReadTextFile = async (
    registry: DaemonRegistryService,
    daemonId: string,
    absPath: string
): Promise<string | null> => {
    try {
        const res = await registry.rpc({
            daemonId,
            method: 'fs.read',
            payload: { path: absPath, chunked: false },
            timeoutMs: 30_000
        })
        return String((res as { content?: string } | undefined)?.content ?? '')
    } catch (err) {
        if (isMissingFileError(err)) return null
        throw err
    }
}
