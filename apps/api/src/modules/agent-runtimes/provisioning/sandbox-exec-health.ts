import {
    execSprite,
    SpritesError,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'

// Short on purpose: the failure this probe exists to catch (a sprite backend
// whose exec upgrade hangs, then answers 502) took 35.98–36.91s to surface on
// staging. Waiting that out per candidate host is most of the cost of the bug,
// so the probe gives up long before the platform does and lets the caller move
// to another host.
export const SANDBOX_EXEC_PROBE_TIMEOUT_MS = 15_000
export const SANDBOX_EXEC_PROBE_ATTEMPTS = 2
export const SANDBOX_EXEC_PROBE_RETRY_DELAY_MS = 500

export interface SandboxExecProbeResult {
    ok: boolean
    attempts: number
    detail?: string
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Ask a sandbox VM to run a no-op before we trust it with a framework
 * bootstrap. Reusing an existing host means the bootstrap's FIRST exec is where
 * a dead exec endpoint surfaces — as a create failure the user sees, on a host
 * the next create would pick again.
 *
 * Retrying is safe here and only here: the command is `exit 0`, so replaying it
 * cannot duplicate a side effect. That is why the retry lives in this probe
 * instead of inside `execSpriteStream`, which is shared with terminal, file and
 * agent-turn execution — Sprites does not guarantee that a failed WebSocket
 * upgrade means the command was never accepted, so replaying arbitrary commands
 * there could run them twice.
 *
 * Transient failures before the socket opens (5xx handshake, transport error,
 * timeout) return `ok: false` so the caller can quarantine the host and fail
 * over. A post-open failure proves the endpoint answered and throws, as do auth,
 * quota, not_found, conflict and permanent errors: none is a host-health verdict.
 */
export const probeSandboxExec = async (args: {
    client: SpritesClient
    spriteName: string
    logger?: SpritesLogger
    timeoutMs?: number
    attempts?: number
    retryDelayMs?: number
}): Promise<SandboxExecProbeResult> => {
    const maxAttempts = args.attempts ?? SANDBOX_EXEC_PROBE_ATTEMPTS
    const retryDelayMs = args.retryDelayMs ?? SANDBOX_EXEC_PROBE_RETRY_DELAY_MS
    let detail = 'no attempt made'
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const result = await execSprite(
                args.client,
                args.spriteName,
                {
                    cmd: ['bash', '-lc', 'exit 0'],
                    stdin: '',
                    timeoutMs: args.timeoutMs ?? SANDBOX_EXEC_PROBE_TIMEOUT_MS
                },
                args.logger
            )
            if (result.exitCode === 0) return { ok: true, attempts: attempt }
            // The socket opened and the VM answered. The attach may still fail,
            // but this is proof that the exec endpoint itself is reachable, so
            // it must not quarantine the host.
            throw new SpritesError(
                'permanent',
                `sandbox exec probe exited ${result.exitCode}`,
                undefined,
                undefined,
                { execPhase: 'post_open' }
            )
        } catch (err) {
            if (
                !(err instanceof SpritesError) ||
                err.code !== 'transient' ||
                err.execPhase !== 'pre_open'
            )
                throw err
            detail = probeFailureDetail(err)
            args.logger?.warn('sprites.exec.probe.failed', {
                spriteName: args.spriteName,
                attempt,
                maxAttempts,
                failureClass: `SpritesError:${err.code}`,
                upstreamStatus: err.status
            })
            if (attempt < maxAttempts) await sleep(retryDelayMs)
        }
    }
    return { ok: false, attempts: maxAttempts, detail }
}

const probeFailureDetail = (err: SpritesError): string => {
    if (err.status !== undefined) return `exec handshake HTTP ${err.status}`
    if (/timed out after \d+ms/i.test(err.message))
        return 'exec probe timed out'
    return 'exec transport unavailable'
}
