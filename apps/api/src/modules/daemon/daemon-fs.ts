import type { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'

// Small-file and bash primitives over the daemon RPC, for services that
// materialize per-agent config onto a self-owned computer (#781) — the same
// shapes the skill materializer already drives, factored out so the MCP and
// context-doc paths don't hand-copy them.

export const runDaemonBash = async (
    registry: DaemonRegistryService,
    daemonId: string,
    script: string,
    timeoutMs: number
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
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

const isMissingFileError = (err: unknown): boolean =>
    /ENOENT/i.test((err as Error)?.message ?? '')

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

// Plain UTF-8 body on purpose: MCP config is text, and the base64 encoding is
// only honoured by daemons advertising fs.write.binary — a plain string is the
// one shape every CLI version writes faithfully. `mode` is applied only by
// daemons advertising fs.write.mode; the caller gates secret-carrying writes.
export const daemonWriteTextFile = async (
    registry: DaemonRegistryService,
    daemonId: string,
    absPath: string,
    text: string,
    mode?: string
): Promise<void> => {
    await registry.rpc({
        daemonId,
        method: 'fs.write',
        payload: {
            path: absPath,
            content: text,
            ...(mode ? { mode } : {})
        },
        timeoutMs: 30_000
    })
}
