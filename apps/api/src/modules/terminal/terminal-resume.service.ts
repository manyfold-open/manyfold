import { Inject, Injectable, Logger } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { agentCredentials, chatSessions, type Database } from '@manyfold/db'
import type { AgentFramework } from '@manyfold/shared'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { resolveAnthropicBaseUrl } from '@/modules/agents/orchestration/bootstrap-invariants'
import {
    frameworkSupportsTerminalResume,
    terminalResumeCommand,
    terminalResumeNeedsModelCredentials
} from '@/modules/terminal/terminal-resume-command'

export interface ResolvedTerminalResume {
    command: string[]
    // Empty unless the framework needs platform credentials AND the sandbox
    // opted in. These are the same three variables the chat adapter injects
    // per exec; the difference is that here they outlive a single turn.
    env: Record<string, string>
}

@Injectable()
export class TerminalResumeService {
    private readonly log = new Logger(TerminalResumeService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService
    ) {}

    /* Resolve a chat session into the argv that drops the terminal straight
       into that session's TUI, or null when it cannot.

       The caller has already authorized the agent, and the query pins
       agent_id, so a session belonging to somebody else's agent simply does
       not match — no separate ownership check is needed. Every failure is a
       silent null: the terminal still opens, it just opens as a plain shell,
       which is strictly better than refusing the connection. */
    async resolve(args: {
        agentId: string
        runtimeId: string
        framework: AgentFramework
        chatSessionId: string
        // Whether this runtime is allowed to authenticate the TUI at all.
        modelCredentialsAllowed: boolean
        // Whether the credentials must be handed to the shell. False on a
        // daemon: the CLI sign-in already on the user's machine is what the
        // TUI will use, so there is nothing to inject.
        injectModelCredentials: boolean
    }): Promise<ResolvedTerminalResume | null> {
        if (!frameworkSupportsTerminalResume(args.framework)) return null

        const needsCredentials = terminalResumeNeedsModelCredentials(
            args.framework
        )
        if (needsCredentials && !args.modelCredentialsAllowed) {
            this.log.log(
                `terminal.resume.skipped agent=${args.agentId} reason=model-credentials-not-allowed`
            )
            return null
        }

        const [row] = await this.db
            .select({ ref: chatSessions.frameworkSessionRef })
            .from(chatSessions)
            .where(
                and(
                    eq(chatSessions.id, args.chatSessionId),
                    eq(chatSessions.agentId, args.agentId)
                )
            )
            .limit(1)

        if (!row?.ref) return null
        const command = terminalResumeCommand(args.framework, row.ref)
        if (!command) return null

        const inject = needsCredentials && args.injectModelCredentials
        const env = inject ? await this.claudeCredentialEnv(args.runtimeId) : {}
        if (inject && !Object.keys(env).length) {
            this.log.warn(
                `terminal.resume.skipped agent=${args.agentId} reason=credentials-unreadable`
            )
            return null
        }
        // The resumed TUI must keep writing its transcript, or the conversation
        // continued there is invisible to the next --resume and to the chat
        // view's session recovery — the two front ends would silently diverge.
        // Claude Code disables persistence when it sees an inherited
        // CLAUDE_CODE_CHILD_SESSION marker (e.g. a daemon launched from inside
        // another Claude session), so force it on. No-op when persistence is
        // already the default.
        if (args.framework === 'claude-code')
            env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1'
        return { command, env }
    }

    private async claudeCredentialEnv(
        runtimeId: string
    ): Promise<Record<string, string>> {
        const [row] = await this.db
            .select({
                payloadCiphertext: agentCredentials.payloadCiphertext,
                keyVersion: agentCredentials.keyVersion
            })
            .from(agentCredentials)
            .where(eq(agentCredentials.runtimeId, runtimeId))
            .limit(1)
        if (!row) return {}
        try {
            const creds = JSON.parse(
                this.crypto.decrypt({
                    ciphertext: row.payloadCiphertext,
                    keyVersion: row.keyVersion
                })
            ) as { anthropicAuthToken?: string; anthropicBaseUrl?: string }
            if (!creds.anthropicAuthToken) return {}
            return {
                ANTHROPIC_BASE_URL: resolveAnthropicBaseUrl({
                    source: 'byo',
                    byoBaseUrl: creds.anthropicBaseUrl
                }),
                ANTHROPIC_AUTH_TOKEN: creds.anthropicAuthToken,
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
            }
        } catch {
            return {}
        }
    }
}
