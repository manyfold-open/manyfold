import type { ExecDriverFactory } from '../src/modules/chat/adapters/exec-driver-factory'
import type { ChatRepository } from '../src/modules/chat/chat.repository'

// Chat lifecycle tests supply their own adapter; its admitted carrier is fixed.
export const readyChatRunner = (drivers?: unknown): ExecDriverFactory =>
    ({
        resolveRunner: async () => ({ daemonId: 'dh_test', exec: null }),
        ...(drivers as object | undefined)
    }) as unknown as ExecDriverFactory

export const withRunnerCursors = (repo: unknown): ChatRepository => {
    const fixture = (repo ?? {}) as ChatRepository
    fixture.exactResumeSeqForMessage ??= async () => 0
    fixture.safeResumeSeqForMessage ??= async () => 0
    return fixture
}
