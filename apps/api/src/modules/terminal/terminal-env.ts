import type { ConfigService } from '@nestjs/config'
import { MF_ENV_API_TOKEN, MF_ENV_TERMINAL_ID } from '@manyfold/shared'
import { manyfoldRuntimeEnv } from '@/modules/chat/adapters/exec-driver-factory'

// The platform's own block of a Manyfold-opened terminal's env, laid over
// everything the agent or a profile contributed so a session cannot rebind it.
// The four-key runtime identity is the same one a chat turn's process gets (a
// terminal shell is where the user runs `mf` by hand, and the daemon arm used
// to inject only two of the four, leaving `mf` to fall back to whatever
// profile the machine had); the terminal id on top is what turns the CLI
// session hooks on, and only there (ADR-0029 §3).
export const terminalIdentityEnv = (args: {
    config: ConfigService | undefined
    agentId: string
    terminalId: string | null | undefined
    tokenPlaintext: string
}): Record<string, string> => ({
    ...manyfoldRuntimeEnv(args.config, args.agentId),
    ...(args.terminalId ? { [MF_ENV_TERMINAL_ID]: args.terminalId } : {}),
    [MF_ENV_API_TOKEN]: args.tokenPlaintext
})
