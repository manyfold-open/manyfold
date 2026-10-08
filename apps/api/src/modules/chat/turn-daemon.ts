import type { RuntimePlacement, ChatError } from '@manyfold/shared'
import type { ExecEndpointFailure } from '@/modules/hosts/providers/sandbox-provider'
import {
    SANDBOX_MAINTENANCE_CODE,
    SANDBOX_MAINTENANCE_MESSAGE
} from '@/modules/chat/sandbox-maintenance-terminal'

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
        readonly reason: string,
        upgradeRequired = false,
        readonly execFailure?: ExecEndpointFailure
    ) {
        // A sandbox in maintenance is refused on purpose: its own code and
        // copy, and never retryable, so automation runs don't wait on it.
        const maintenance = reason === SANDBOX_MAINTENANCE_CODE
        const action = upgradeRequired
            ? runtime === 'k8s'
                ? 'Update the Pod image with a current mf daemon runner.'
                : runtime === 'sprites'
                  ? "Update the sandbox's Manyfold CLI from the Update Center (or mf sandbox update)."
                  : 'Run mf update and restart the daemon runner.'
            : reason === 'runner_updating'
              ? 'The machine is updating its Manyfold CLI once its current work finishes; retry in a few minutes.'
              : 'Check the daemon runner connection and retry.'
        super(
            maintenance
                ? SANDBOX_MAINTENANCE_MESSAGE
                : `Chat runner unavailable (${reason}). ${action}`
        )
        this.chatError = maintenance
            ? {
                  code: SANDBOX_MAINTENANCE_CODE,
                  message: this.message,
                  retryable: false
              }
            : {
                  code: upgradeRequired
                      ? 'chat_runner_upgrade_required'
                      : 'chat_runner_unavailable',
                  message: this.message,
                  retryable: !upgradeRequired
              }
    }
}
