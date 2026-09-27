import type { DaemonAuthContextRef, DaemonStreamKind } from '@manyfold/shared'
import type { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import type { DaemonFencedDispatchService } from './daemon-fenced-dispatch.service'
import type {
    ExecDriver,
    ExecResumeRequest,
    ExecStreamHandle,
    ExecStreamRequest,
    ExecStreamResult
} from './exec-driver'
import { observedResult } from './exec-driver'
import { isTransportLoss } from '@/modules/agents/adapters/host-daemon-access'

export interface DaemonExecDriverOptions {
    // Directories the platform vouches for beyond the daemon's own; sent
    // on every exec.start (DAEMON_FEATURE_EXEC_ROOTS).
    roots?: readonly string[]
    // Waits for the daemon's fresh lease after a thaw replaced its socket;
    // true once it is back. A first exec.start lost to the old socket is
    // sent once more on the new one.
    reconnect?: (since: Date) => Promise<boolean>
}

interface StreamSinks {
    stdout: AsyncIterable<string>
    stderr: AsyncIterable<string>
    push: (kind: DaemonStreamKind, data: string, seq?: number) => void
    close: () => void
    lastDeliveredSeq: () => number
}

interface Chunk {
    data: string
    seq: number
}

const makeSinks = (): StreamSinks => {
    const stdoutBuf: Chunk[] = []
    const stderrBuf: Chunk[] = []
    const stdoutWaiters: Array<(v: IteratorResult<string>) => void> = []
    const stderrWaiters: Array<(v: IteratorResult<string>) => void> = []
    let stdoutDone = false
    let stderrDone = false
    // Advanced on DEQUEUE, never on arrival: the resume cursor must describe
    // what the consumer has actually taken, not what the socket delivered.
    let lastDeliveredSeq = 0
    const deliver = (chunk: Chunk): string => {
        if (chunk.seq > lastDeliveredSeq) lastDeliveredSeq = chunk.seq
        return chunk.data
    }
    const pushStdout = (chunk: Chunk): void => {
        if (stdoutWaiters.length > 0)
            stdoutWaiters.shift()!({ value: deliver(chunk), done: false })
        else stdoutBuf.push(chunk)
    }
    const pushStderr = (chunk: Chunk): void => {
        if (stderrWaiters.length > 0)
            stderrWaiters.shift()!({ value: deliver(chunk), done: false })
        else stderrBuf.push(chunk)
    }
    const close = (): void => {
        stdoutDone = true
        stderrDone = true
        while (stdoutWaiters.length > 0)
            stdoutWaiters.shift()!({ value: undefined, done: true })
        while (stderrWaiters.length > 0)
            stderrWaiters.shift()!({ value: undefined, done: true })
    }
    const stdout: AsyncIterable<string> = {
        [Symbol.asyncIterator]: () => ({
            next: () =>
                new Promise<IteratorResult<string>>((resolve) => {
                    if (stdoutBuf.length > 0)
                        return resolve({
                            value: deliver(stdoutBuf.shift()!),
                            done: false
                        })
                    if (stdoutDone)
                        return resolve({ value: undefined, done: true })
                    stdoutWaiters.push(resolve)
                })
        })
    }
    const stderr: AsyncIterable<string> = {
        [Symbol.asyncIterator]: () => ({
            next: () =>
                new Promise<IteratorResult<string>>((resolve) => {
                    if (stderrBuf.length > 0)
                        return resolve({
                            value: deliver(stderrBuf.shift()!),
                            done: false
                        })
                    if (stderrDone)
                        return resolve({ value: undefined, done: true })
                    stderrWaiters.push(resolve)
                })
        })
    }
    return {
        stdout,
        stderr,
        push: (kind, data, seq) => {
            const chunk = { data, seq: seq ?? 0 }
            if (kind === 'stdout') pushStdout(chunk)
            else if (kind === 'stderr') pushStderr(chunk)
        },
        close,
        lastDeliveredSeq: () => lastDeliveredSeq
    }
}

const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

// Codex per-agent skills: the sprite driver runs the final exec under
// `env HOME=<workspace> CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"`. A runner turn is the same
// sprite, so it needs the same relocation or codex resolves its USER skill
// scope (`$HOME/.agents/skills`) against the sprite home and the agent's skills
// silently disappear. `$HOME` expands inside the sprite (to the real home)
// before env overrides it for the child, which is how CODEX_HOME keeps pointing
// at the real config/auth. `exec` keeps the process tree flat so cancellation
// still reaches codex.
const withCodexHome = (cmd: string[], codexHome?: string): string[] =>
    codexHome
        ? [
              'bash',
              '-c',
              `exec env HOME=${shellQuote(codexHome)} CODEX_HOME="\${CODEX_HOME:-$HOME/.codex}" ` +
                  cmd.map(shellQuote).join(' ')
          ]
        : cmd

export class DaemonExecDriver implements ExecDriver {
    // baseEnv is the per-agent runtime identity (MF_API_TOKEN / MF_AGENT_ID /
    // MF_API_URL / MF_DEPLOY_ENV plus connection env). The sprite driver carries
    // the same base internally and the sprite profile deliberately persists no
    // token, so a runner turn that drops it leaves the child on the shared
    // spriterunner profile and every authenticated `mf` call 401s (#581).
    // req.env (model/provider credentials) wins on conflict, mirroring the
    // sprite driver's mergeEnv precedence.
    constructor(
        private readonly registry: DaemonRegistryService,
        private readonly daemonId: string,
        private readonly baseEnv?: Record<string, string>,
        // Appended LAST and optional so existing positional construction keeps
        // working; absent, the driver dispatches unfenced as before.
        private readonly fencedDispatch?: DaemonFencedDispatchService,
        // A profile-bound agent: the daemon resolves this ref into the
        // credential context itself (DAEMON_FEATURE_AUTH_CONTEXT). Null =
        // inherited, today's behaviour.
        private readonly authContext: DaemonAuthContextRef | null = null,
        private readonly options: DaemonExecDriverOptions = {}
    ) {}

    stream(req: ExecStreamRequest): ExecStreamHandle {
        const sinks = makeSinks()
        const roots = [...(req.roots ?? this.options.roots ?? [])]
        const payload = {
            cmd: withCodexHome(req.cmd, req.codexHome),
            env: { ...(this.baseEnv ?? {}), ...(req.env ?? {}) },
            stdin: req.stdin ?? '',
            dir: req.dir,
            ...(roots.length ? { roots } : {}),
            timeoutMs: req.timeoutMs,
            ...(req.temporarySettings ? { temporarySettings: req.temporarySettings } : {}),
            ...(this.authContext
                ? { authSelection: { mode: 'profile', ...this.authContext } }
                : {})
        }
        // Anything the daemon sent back proves it has the exec; only a
        // request it never saw is sent again below.
        let received = 0
        const onEvent: typeof sinks.push = (kind, data, seq) => {
            received += 1
            sinks.push(kind, data, seq)
        }
        // The fence needs a stable exec ref to probe and re-pin (#619); a
        // stream without one (no execHandle) keeps the plain transport.
        const dispatch = () =>
            req.execHandle && this.fencedDispatch
                ? this.fencedDispatch.streamTurnRpc({
                      daemonId: this.daemonId,
                      method: 'exec.start',
                      payload,
                      timeoutMs: req.timeoutMs + 10_000,
                      onEvent,
                      refId: req.execHandle
                  })
                : this.registry.streamRpc({
                      daemonId: this.daemonId,
                      method: 'exec.start',
                      payload,
                      timeoutMs: req.timeoutMs + 10_000,
                      onEvent,
                      ...(req.execHandle
                          ? { refIdOverride: req.execHandle }
                          : {})
                  })
        const since = new Date()
        let current: ReturnType<typeof dispatch> | null = null
        const attempt = (): Promise<Record<string, unknown> | undefined> => {
            current = dispatch()
            return current.result
        }
        // Lost to the socket, not refused by the daemon, and nothing arrived
        // yet: the daemon never saw it, so once it is back on a fresh lease
        // the same request goes again. Anything received means the daemon
        // has the exec; that case is the resume path's.
        const reconnect = this.options.reconnect
        const dispatched = new Promise<Record<string, unknown> | undefined>(
            (resolve, reject) => {
                let first: Promise<Record<string, unknown> | undefined>
                try {
                    first = attempt()
                } catch (err) {
                    first = Promise.reject(err)
                }
                first.then(resolve, (err: unknown) => {
                    if (!reconnect || received > 0 || !isTransportLoss(err, false))
                        return reject(err)
                    reconnect(since).then(
                        (back) => {
                            if (!back) return reject(err)
                            try {
                                attempt().then(resolve, reject)
                            } catch (again) {
                                reject(again)
                            }
                        },
                        () => reject(err)
                    )
                })
            }
        )
        const result: Promise<ExecStreamResult> = dispatched
            .then((payload) => {
                sinks.close()
                return {
                    exitCode: Number(payload?.exitCode ?? 0),
                    stdout: '',
                    stderr: ''
                }
            })
            .catch((err) => {
                sinks.close()
                throw err
            })
        return {
            stdout: sinks.stdout,
            stderr: sinks.stderr,
            result: observedResult(result),
            abort: () => current?.cancel(),
            lastDeliveredSeq: sinks.lastDeliveredSeq
        }
    }

    resumeStream(req: ExecResumeRequest): ExecStreamHandle {
        const sinks = makeSinks()
        const stream = this.registry.streamRpc({
            daemonId: this.daemonId,
            method: 'exec.resume',
            payload: {
                originalRefId: req.refId,
                fromSeq: req.fromSeq
            },
            timeoutMs: req.timeoutMs + 10_000,
            onEvent: sinks.push
        })
        const result: Promise<ExecStreamResult> = stream.result
            .then((payload) => {
                sinks.close()
                return {
                    exitCode: Number(payload?.exitCode ?? 0),
                    stdout: '',
                    stderr: ''
                }
            })
            .catch((err) => {
                sinks.close()
                throw err
            })
        let aborted = false
        const abort = (): void => {
            if (aborted) return
            aborted = true
            stream.cancel()
            // Current daemons abort the original child when this attachment is
            // cancelled. The explicit abort keeps older daemons safe too.
            void this.registry
                .rpc({
                    daemonId: this.daemonId,
                    method: 'exec.abort',
                    payload: { refId: req.refId },
                    timeoutMs: 10_000
                })
                .catch(() => undefined)
        }
        return {
            stdout: sinks.stdout,
            stderr: sinks.stderr,
            result: observedResult(result),
            abort,
            lastDeliveredSeq: sinks.lastDeliveredSeq
        }
    }
}
