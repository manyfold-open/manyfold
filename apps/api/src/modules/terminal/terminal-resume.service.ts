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

// What became of the resume the client asked for, reported on the terminal's
// session_info frame. `unavailable` covers every durable reason (framework,
// credentials, no session ref yet) — the client derives those itself from the
// agent's own configuration. `turn-in-flight` is the one it cannot derive and
// the one that clears on its own, so the tab records it and knows to rebuild
// into the TUI once the turn ends.
export type TerminalResumeOutcome =
    | 'applied'
    | 'turn-in-flight'
    | 'unavailable'

interface TerminalResumeResolution {
    resume: ResolvedTerminalResume | null
    outcome: TerminalResumeOutcome
}

const UNAVAILABLE: TerminalResumeResolution = {
    resume: null,
    outcome: 'unavailable'
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
       not match — no separate ownership check is needed. No failure refuses
       the connection: the terminal still opens, it just opens as a plain
       shell, and the outcome says which kind of plain shell it is. */
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
    }): Promise<TerminalResumeResolution> {
        if (!frameworkSupportsTerminalResume(args.framework)) return UNAVAILABLE

        const needsCredentials = terminalResumeNeedsModelCredentials(
            args.framework
        )
        if (needsCredentials && !args.modelCredentialsAllowed) {
            this.log.log(
                `terminal.resume.skipped agent=${args.agentId} reason=model-credentials-not-allowed`
            )
            return UNAVAILABLE
        }

        const [row] = await this.db
            .select({
                ref: chatSessions.frameworkSessionRef,
                inflightMessageId: chatSessions.inflightMessageId
            })
            .from(chatSessions)
            .where(
                and(
                    eq(chatSessions.id, args.chatSessionId),
                    eq(chatSessions.agentId, args.agentId)
                )
            )
            .limit(1)

        if (!row?.ref) return UNAVAILABLE
        /* A turn still holds the session, so the CLI process that turn is
           running owns the framework session on disk. Pointing a second one at
           the same session id does not join the conversation, it collides
           with it. Codex enforces that and refuses outright (`already has an
           active writer`), which is what the user saw instead of a shell;
           claude does not enforce it, and two processes appending to one
           transcript is the silent divergence the rebuild guard in
           AgentChat.tsx already refuses to cause mid-stream.

           inflight_message_id is the gate rather than "is a stream connected"
           because it is released only by the turn's done/error terminal, so it
           still reads as held while a turn sits SUSPENDED — exactly the state
           whose CLI is alive on the runtime with the API no longer watching.
           Seen on production [2026-09-07]: a suspended codex turn's terminal
           resume died on the -32600 the holder was still earning.

           Held proves a writer is alive; released does not prove one is gone.
           A turn that adoption gave up on, or that was cancelled, releases the
           claim without stopping the process on the runtime, and a resume
           admitted then still meets the refusal — as the raw error, since the
           client has nothing to explain it with. That orphan is the chat
           turn's problem to reap; this gate only stops the terminal from
           being the thing that collides with a turn the platform is carrying.

           Fall through to a plain shell, like every other unmet condition
           here. The turn keeps the session; the user keeps a terminal. */
        if (row.inflightMessageId) {
            this.log.log(
                `terminal.resume.skipped agent=${args.agentId} reason=turn-in-flight`
            )
            return { resume: null, outcome: 'turn-in-flight' }
        }
        const command = terminalResumeCommand(args.framework, row.ref)
        if (!command) return UNAVAILABLE

        const inject = needsCredentials && args.injectModelCredentials
        const env = inject ? await this.claudeCredentialEnv(args.runtimeId) : {}
        if (inject && !Object.keys(env).length) {
            this.log.warn(
                `terminal.resume.skipped agent=${args.agentId} reason=credentials-unreadable`
            )
            return UNAVAILABLE
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
        return { resume: { command, env }, outcome: 'applied' }
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
