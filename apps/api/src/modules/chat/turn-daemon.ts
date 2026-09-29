import type { RuntimePlacement, ChatError } from '@manyfold/shared'
import type { ExecEndpointFailure } from '@/modules/hosts/providers/sandbox-provider'

// The daemon a turn was resolved to: the host id is its routing key.
export interface TurnDaemon {
    hostId: string
    // The directories this agent's turns run in beyond the daemon's own
    // roots; they travel on every exec.start (DAEMON_FEATURE_EXEC_ROOTS).
    roots: readonly string[]
}

export class TurnDaemonError extends Error {
    readonly chatError: ChatError

    constructor(
        runtime: RuntimePlacement,
        reason: string,
        upgradeRequired = false,
        readonly execFailure?: ExecEndpointFailure
    ) {
        const action = upgradeRequired
            ? runtime === 'k8s'
                ? 'Update the Pod image with a current mf daemon runner.'
                : runtime === 'sprites'
                  ? 'Ask an administrator to update the managed Sprite runner.'
                  : 'Run mf update and restart the daemon runner.'
            : reason === 'runner_updating'
              ? 'The machine is updating its Manyfold CLI once its current work finishes; retry in a few minutes.'
              : 'Check the daemon runner connection and retry.'
        super(`Chat runner unavailable (${reason}). ${action}`)
        this.chatError = {
            code: upgradeRequired
                ? 'chat_runner_upgrade_required'
                : 'chat_runner_unavailable',
            message: this.message,
            retryable: !upgradeRequired
        }
    }
}
