import type { PodExec } from '@/modules/k8s/pod-exec'
import type {
    ExecDriver,
    ExecStreamHandle,
    ExecStreamRequest,
    InteractiveExecHandle,
    InteractiveExecRequest
} from './exec-driver'
import { observedResult } from './exec-driver'

const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

// Wrap a command with env exports and GNU `timeout` so that:
//   (a) env vars passed via ExecStreamRequest.env are visible to the binary
//       (pod exec has no env channel; the container's Secret envFrom covers
//       baseline creds, but adapter-level one-off vars still need inlining);
//   (b) the remote process self-terminates if the caller timeoutMs elapses.
// We also fall back to a host-side timer that closes the upstream WS.
//
// Use a non-login shell (`bash -c`, not `bash -lc`): the container's Dockerfile
// `ENV PATH=...` (which includes mise shims at `/home/node/.local/share/mise/shims`)
// is inherited as-is, whereas a login shell sources `/etc/profile` and clobbers
// PATH back to the system default — making mise-managed binaries (`claude`,
// `codex`, `gemini`) unreachable.
const wrapCommand = (
    cmd: string[],
    env: Record<string, string> | undefined,
    dir: string | undefined,
    timeoutMs: number
): string[] => {
    const envExports = env
        ? Object.entries(env)
              .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
              .join('; ')
        : ''
    const quoted = cmd.map(shellQuote).join(' ')
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
    const cdPrefix = dir ? `cd ${shellQuote(dir)} && ` : ''
    const envPrefix = envExports ? `${envExports}; ` : ''
    return [
        'bash',
        '-c',
        `${cdPrefix}${envPrefix}timeout ${seconds}s ${quoted}`
    ]
}

export class K8sExecDriver implements ExecDriver {
    constructor(private readonly podExec: PodExec) {}

    stream(req: ExecStreamRequest): ExecStreamHandle {
        const wrapped = wrapCommand(req.cmd, req.env, req.dir, req.timeoutMs)
        const handle = this.podExec.stream({
            cmd: wrapped,
            stdin: req.stdin,
            timeoutMs: req.timeoutMs + 5_000
        })
        return {
            stdout: handle.stdout,
            stderr: handle.stderr,
            result: observedResult(handle.result),
            abort: handle.abort
        }
    }

    streamInteractive(req: InteractiveExecRequest): InteractiveExecHandle {
        // Same wrapper as stream(): env inlined into the shell (pod exec has
        // no env channel) and GNU `timeout` as the in-container backstop for
        // a child that survives websocket teardown.
        const wrapped = wrapCommand(req.cmd, req.env, req.dir, req.timeoutMs)
        const handle = this.podExec.streamInteractive({
            cmd: wrapped,
            timeoutMs: req.timeoutMs + 5_000
        })
        return {
            stdout: handle.stdout,
            stderr: handle.stderr,
            write: (data: Buffer) => handle.stdin.write(data),
            endInput: () => handle.stdin.end(),
            result: observedResult(handle.result),
            abort: handle.abort
        }
    }
}
