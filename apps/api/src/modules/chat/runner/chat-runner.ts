import type { SpritesClient } from '@manyfold/sprites'
import type { AgentRuntime, ChatError } from '@manyfold/shared'
import type { RunnerExecFailure, SpriteExecFn } from './runner-manager.service'

export interface ChatRunner {
    daemonId: string
    exec: SpriteExecFn | null
    spritesClient?: SpritesClient
}

export class ChatRunnerError extends Error {
    readonly chatError: ChatError

    constructor(
        runtime: AgentRuntime,
        reason: string,
        upgradeRequired = false,
        readonly execFailure?: RunnerExecFailure
    ) {
        const action = upgradeRequired
            ? runtime === 'k8s'
                ? 'Update the Pod image with a current mf daemon runner.'
                : runtime === 'sprites'
                  ? 'Ask an administrator to update the managed Sprite runner.'
                  : 'Run mf update and restart the daemon runner.'
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
