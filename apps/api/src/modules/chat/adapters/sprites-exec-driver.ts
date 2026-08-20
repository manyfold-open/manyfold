import {
    MF_ENV_AGENT_ID,
    MF_ENV_API_TOKEN,
    PATH_PREPEND_LOCAL_BIN
} from '@manyfold/shared'
import {
    execSpriteStream,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import type {
    ExecDriver,
    ExecStreamHandle,
    ExecStreamRequest,
    ExecStreamResult
} from './exec-driver'
import { observedResult } from './exec-driver'
import type { SpritesSessionRegistry } from '@/modules/agents/sprite-sessions/sprite-sessions.registry'
import {
    MF_SHELL_ENV_START,
    MF_SHELL_ENV_END
} from '@/modules/agent-self/sprite-shell-env.service'

const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

// Non-interactive sprite exec runs under `bash -c`, which sources no profile,
// so the managed env block (MF_API_TOKEN included) written to the home profile
// is invisible to agent turns. Source it before exec: prefer /etc/profile.d/mf.sh,
// fall back to the pre-rename nca.sh, and otherwise eval just the sentinel block
// out of ~/.profile. All branches no-op cleanly when absent.
const sourceManagedEnv =
    'if [ -f /etc/profile.d/mf.sh ]; then . /etc/profile.d/mf.sh; ' +
    'elif [ -f /etc/profile.d/nca.sh ]; then . /etc/profile.d/nca.sh; ' +
    `elif [ -f "$HOME/.profile" ]; then if grep -q '${MF_SHELL_ENV_START}' "$HOME/.profile"; then eval "$(sed -n '/${MF_SHELL_ENV_START}/,/${MF_SHELL_ENV_END}/p' "$HOME/.profile")"; else eval "$(sed -n '/# nca-env-start/,/# nca-env-end/p' "$HOME/.profile")"; fi; fi`

export const wrapSpriteCommand = (
    cmd: string[],
    dir: string | undefined,
    identityEnv?: Record<string, string>,
    codexHome?: string
): string[] => {
    const quoted = cmd.map(shellQuote).join(' ')
    const cd = dir ? `cd ${shellQuote(dir)} && ` : ''
    // Re-export the per-agent identity AFTER sourcing the managed profile so a
    // stale MF_API_TOKEN/MF_AGENT_ID left in a legacy /etc/profile.d/nca.sh can
    // never clobber the per-exec identity (co-resident agents stay distinct).
    const reexport = [MF_ENV_API_TOKEN, MF_ENV_AGENT_ID]
        .filter((key) => identityEnv?.[key])
        .map((key) => `export ${key}=${shellQuote(identityEnv![key])}; `)
        .join('')
    // Codex per-agent skills: HOME goes on the FINAL exec only (never the env
    // block above) so sourceManagedEnv + the `$HOME/.local/bin` PATH still use
    // the real home — only codex inherits HOME=<workspace>, and CODEX_HOME keeps
    // its config/auth/sessions in the real `~/.codex`.
    const execPrefix = codexHome
        ? `env HOME=${shellQuote(codexHome)} CODEX_HOME="$HOME/.codex" `
        : ''
    return [
        'bash',
        '-c',
        `${sourceManagedEnv}; ${PATH_PREPEND_LOCAL_BIN}; ${reexport}${cd}exec ${execPrefix}${quoted}`
    ]
}

export interface SpritesExecDriverDeps {
    sessionRegistry: SpritesSessionRegistry
    agentId: string
    env?: Record<string, string>
}

// sprites.dev kills a non-TTY exec 10s after its WSS client disconnects
// (max_run_after_disconnect default), so a transient API↔sprites drop killed
// long agent turns mid-work (#211). Let the process outlive the socket for as
// long as the turn itself may run, capped at 24h so an API crash/deploy can't
// leave an orphaned process keeping the sprite awake (billed) indefinitely.
// Intentional terminations (cancel/timeout) still kill promptly via the
// SDK's kill-on-abort that setting this option opts into.
export const SPRITE_EXEC_MAX_DETACH_SECONDS = 86_400

export const deriveMaxRunAfterDisconnectSeconds = (
    timeoutMs: number
): number =>
    Math.min(SPRITE_EXEC_MAX_DETACH_SECONDS, Math.ceil(timeoutMs / 1000))

export class SpritesExecDriver implements ExecDriver {
    constructor(
        private readonly client: SpritesClient,
        private readonly spriteName: string,
        private readonly logger: SpritesLogger,
        private readonly deps: SpritesExecDriverDeps | null = null
    ) {}

    stream(req: ExecStreamRequest): ExecStreamHandle {
        const env = mergeEnv(this.deps?.env, req.env)
        const handle = execSpriteStream(
            this.client,
            this.spriteName,
            {
                cmd: wrapSpriteCommand(req.cmd, req.dir, env, req.codexHome),
                env,
                stdin: req.stdin ?? '',
                timeoutMs: req.timeoutMs,
                // Chat turns stream their output; the result buffer only feeds
                // error tails, so don't hold a full second copy in memory.
                capture: 'tail',
                // Transparent reconnect: the detached process survives a WSS
                // drop (below), so re-attach and resume the stream instead of
                // erroring the turn and losing everything after the drop.
                reattach: {},
                maxRunAfterDisconnectSeconds:
                    deriveMaxRunAfterDisconnectSeconds(req.timeoutMs),
                ...(req.keepAliveMs !== undefined
                    ? { keepAliveMs: req.keepAliveMs }
                    : {}),
                ...(req.livenessTimeoutMs !== undefined
                    ? { livenessTimeoutMs: req.livenessTimeoutMs }
                    : {}),
                ...(req.onExecSession
                    ? { onSessionId: req.onExecSession }
                    : {})
            },
            this.logger
        )
        const unregister = this.deps
            ? this.deps.sessionRegistry.register(this.deps.agentId, {
                  kind: 'chat-exec',
                  close: () => handle.abort()
              })
            : null
        const result: Promise<ExecStreamResult> = handle.result
            .then((r) => ({
                exitCode: r.exitCode,
                stdout: r.stdout,
                stderr: r.stderr
            }))
            .finally(() => unregister?.())
        return {
            stdout: handle.stdout,
            stderr: handle.stderr,
            result: observedResult(result),
            abort: handle.abort
        }
    }
}

const mergeEnv = (
    base: Record<string, string> | undefined,
    override: Record<string, string> | undefined
): Record<string, string> | undefined => {
    if (!base) return override
    if (!override) return base
    return { ...base, ...override }
}
