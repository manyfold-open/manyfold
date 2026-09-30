import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { agentCredentials, chatSessions, type Database } from '@manyfold/db'
import {
    claudeCliModel,
    claudeModelMapEnv,
    isPiProvider,
    type ClaudeCodeAgentModelConfig
} from '@manyfold/shared'
import { AgentModelConfigService } from '@/modules/agents/model-config/agent-model-config.service'
import type { AgentFramework, AntigravityCliAgentModelConfig } from '@manyfold/shared'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { resolveAnthropicBaseUrl } from '@/modules/agents/orchestration/bootstrap-invariants'
import { piPlatformExec } from '@/modules/agents/credentials/pi-agent-dir'
import { antigravityPlatformExec } from '@/modules/agents/credentials/antigravity-app-dir'
import { platformCodexEnvAndArgs } from '@/modules/agents/credentials/codex-platform-exec'
import { isManagedSkillWorkspace } from '@/modules/skills/skill-utils'
import {
    frameworkSupportsTerminalResume,
    terminalResumeCommand,
    terminalResumeNeedsModelCredentials
} from '@/modules/terminal/terminal-resume-command'

export interface ResolvedTerminalResume {
    command: string[]
    // Empty unless the framework needs platform credentials AND the sandbox
    // opted in. These are the variables the chat adapter injects per exec;
    // the difference is that here they outlive a single turn.
    env: Record<string, string>
}

// What became of the resume the client asked for, reported on the terminal's
// session_info frame. `unavailable` covers every durable reason (framework,
// credentials, no session ref yet) — the client derives those itself from the
// agent's own configuration. `turn-in-flight` is the one it cannot derive and
// the one that clears on its own, so the tab records it and knows to rebuild
// into the TUI once the turn ends. `session-held` is its sibling: another
// terminal owns the session's writes (ADR-0029 §1); it clears when that
// terminal closes or the user takes the session back from the chat view.
export type TerminalResumeOutcome =
    | 'applied'
    | 'turn-in-flight'
    | 'session-held'
    | 'unavailable'

interface TerminalResumeResolution {
    resume: ResolvedTerminalResume | null
    outcome: TerminalResumeOutcome
    // The ref the argv was built from; the gateway acquires the session
    // holder against exactly this value, so a ref that moved in between
    // fails the acquire instead of resuming a stale transcript.
    ref: string | null
}

const UNAVAILABLE: TerminalResumeResolution = {
    resume: null,
    outcome: 'unavailable',
    ref: null
}

@Injectable()
export class TerminalResumeService {
    private readonly log = new Logger(TerminalResumeService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService,
        @Optional() private readonly modelConfigs?: AgentModelConfigService
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
        userId?: string
        runtimeId: string
        framework: AgentFramework
        chatSessionId: string
        // Whether this runtime is allowed to authenticate the TUI at all.
        modelCredentialsAllowed: boolean
        // Whether the credentials must be handed to the shell. False on a
        // daemon: the CLI sign-in already on the user's machine is what the
        // TUI will use, so there is nothing to inject.
        injectModelCredentials: boolean
        workspacePath?: string | null
        // The agent's model, which agy's TUI is told like its turns are.
        model?: string | null
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
            return { resume: null, outcome: 'turn-in-flight', ref: null }
        }
        const argv = terminalResumeCommand(args.framework, row.ref)
        if (!argv) return UNAVAILABLE
        // pi loads a workspace's own files (the skills the platform activated
        // there) only once the project is trusted. The turns trust a managed
        // workspace, so its TUI does too instead of opening on the question.
        const command =
            args.framework === 'pi' &&
            args.workspacePath &&
            isManagedSkillWorkspace(args.workspacePath)
                ? [...argv, '--approve']
                : argv

        const inject = needsCredentials && args.injectModelCredentials
        const resume = !inject
            ? { command, env: {} }
            : args.framework === 'pi'
              ? await this.piPlatformResume(args.runtimeId, command)
              : args.framework === 'antigravity-cli'
                ? await this.antigravityPlatformResume(
                      args.runtimeId,
                      command,
                      args.model ?? null,
                      { agentId: args.agentId, userId: args.userId }
                  )
                : args.framework === 'codex'
                  ? await this.codexPlatformResume(
                        args.runtimeId,
                        command,
                        args.model ?? null
                    )
                  : await this.claudePlatformResume(
                        args.runtimeId,
                        command,
                        args.model ?? null,
                        { agentId: args.agentId, userId: args.userId }
                    )
        if (inject && !Object.keys(resume?.env ?? {}).length) {
            this.log.warn(
                `terminal.resume.skipped agent=${args.agentId} reason=credentials-unreadable`
            )
            return UNAVAILABLE
        }
        const env = resume?.env ?? {}
        // The resumed TUI must keep writing its transcript, or the conversation
        // continued there is invisible to the next --resume and to the chat
        // view's session recovery — the two front ends would silently diverge.
        // Claude Code disables persistence when it sees an inherited
        // CLAUDE_CODE_CHILD_SESSION marker (e.g. a daemon launched from inside
        // another Claude session), so force it on. No-op when persistence is
        // already the default.
        if (args.framework === 'claude-code')
            env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1'
        return {
            resume: { command: resume?.command ?? command, env },
            outcome: 'applied',
            ref: row.ref
        }
    }

    // codex resumes on the provider its turns run on, with the key in the
    // env and the endpoint in `-c` overrides (codex-platform-exec.ts): the
    // machine keeps no platform key for a plain `codex` to find. Those
    // overrides also stop codex from restoring the thread's own model — it
    // takes config.toml's then — so the agent's model is passed as well, as
    // the turns do.
    private async codexPlatformResume(
        runtimeId: string,
        command: string[],
        model: string | null
    ): Promise<ResolvedTerminalResume | null> {
        const creds = (await this.storedCredentials(runtimeId)) as {
            openaiApiKey?: string
            openaiBaseUrl?: string | null
        } | null
        if (!creds?.openaiApiKey) return null
        const argv = [...command]
        const env = platformCodexEnvAndArgs(argv, {
            openaiApiKey: creds.openaiApiKey,
            openaiBaseUrl: creds.openaiBaseUrl ?? undefined
        })
        if (model?.trim()) argv.push('--model', model.trim())
        return { command: argv, env }
    }

    // claude resumes on the key and the model its turns run on: given no
    // --model, Claude Code restores the session's last model, the one from
    // before any switch. Its alias resolves through the agent's model map,
    // as on a turn; without the agent's settings the TUI keeps the session's
    // model rather than an alias Claude Code would map to its own default.
    private async claudePlatformResume(
        runtimeId: string,
        command: string[],
        agentModel: string | null,
        selection: { agentId: string; userId?: string }
    ): Promise<ResolvedTerminalResume | null> {
        const env = await this.claudeCredentialEnv(runtimeId)
        if (!Object.keys(env).length) return { command, env }
        let config: ClaudeCodeAgentModelConfig | null = null
        if (selection.userId && this.modelConfigs) {
            try {
                const turn = await this.modelConfigs.resolveTurnConfig({
                    callerUserId: selection.userId,
                    agentId: selection.agentId,
                    modelConfigSource: 'platform'
                })
                if (turn.modelConfig?.framework === 'claude-code')
                    config = turn.modelConfig
            } catch {
                this.log.warn(
                    `terminal.resume.model-unresolved agent=${selection.agentId}`
                )
            }
        }
        const model = config ? claudeCliModel(config, agentModel) : null
        return {
            command: model ? [...command, '--model', model] : command,
            env: { ...env, ...claudeModelMapEnv(config) }
        }
    }

    private async claudeCredentialEnv(
        runtimeId: string
    ): Promise<Record<string, string>> {
        const creds = (await this.storedCredentials(runtimeId)) as {
            anthropicAuthToken?: string
            anthropicBaseUrl?: string
        } | null
        if (!creds?.anthropicAuthToken) return {}
        return {
            ANTHROPIC_BASE_URL: resolveAnthropicBaseUrl({
                source: 'byo',
                byoBaseUrl: creds.anthropicBaseUrl
            }),
            ANTHROPIC_AUTH_TOKEN: creds.anthropicAuthToken,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
        }
    }

    // pi resumes on the same platform view and key its turns run on
    // (pi-agent-dir.ts): a sign-in left on the sandbox cannot take the TUI
    // over, and a gateway credential finds its endpoint there, not in the
    // sandbox's own ~/.pi/agent.
    private async piPlatformResume(
        runtimeId: string,
        command: string[]
    ): Promise<ResolvedTerminalResume | null> {
        const creds = (await this.storedCredentials(runtimeId)) as {
            apiKey?: string
            provider?: unknown
            baseUrl?: string | null
        } | null
        if (!creds?.apiKey || !isPiProvider(creds.provider)) return null
        const platform = piPlatformExec({
            piArgs: command.slice(1),
            runtimeId,
            provider: creds.provider,
            apiKey: creds.apiKey,
            baseUrl: creds.baseUrl
        })
        return { command: platform.cmd, env: platform.env }
    }

    // agy resumes on the platform view and key its turns run on
    // (antigravity-app-dir.ts), told the agent's model as they are: agy keeps
    // no model per conversation, so its TUI would open on its own default.
    private async antigravityPlatformResume(
        runtimeId: string,
        command: string[],
        agentModel: string | null,
        selection: { agentId: string; userId?: string }
    ): Promise<ResolvedTerminalResume | null> {
        const creds = (await this.storedCredentials(runtimeId)) as {
            googleApiKey?: string
            googleGeminiBaseUrl?: string | null
            model?: string | null
        } | null
        if (!creds?.googleApiKey) return null
        let config: AntigravityCliAgentModelConfig | null = null
        if (selection.userId && this.modelConfigs) {
            try {
                const turn = await this.modelConfigs.resolveTurnConfig({
                    callerUserId: selection.userId,
                    agentId: selection.agentId,
                    modelConfigSource: 'platform'
                })
                if (turn.modelConfig?.framework === 'antigravity-cli')
                    config = turn.modelConfig
            } catch {
                this.log.warn(
                    `terminal.resume.skipped agent=${selection.agentId} reason=model-config-unavailable`
                )
                return null
            }
        }
        const model =
            config?.model ?? (agentModel?.trim() || creds.model?.trim() || null)
        const platform = antigravityPlatformExec({
            agyArgs: command.slice(1),
            model,
            providerModel: config?.providerModel,
            runtimeId,
            apiKey: creds.googleApiKey,
            baseUrl: creds.googleGeminiBaseUrl ?? null,
            managedHost: true
        })
        return { command: platform.cmd, env: platform.env }
    }

    private async storedCredentials(runtimeId: string): Promise<unknown> {
        const [row] = await this.db
            .select({
                payloadCiphertext: agentCredentials.payloadCiphertext,
                keyVersion: agentCredentials.keyVersion
            })
            .from(agentCredentials)
            .where(eq(agentCredentials.runtimeId, runtimeId))
            .limit(1)
        if (!row) return null
        try {
            return JSON.parse(
                this.crypto.decrypt({
                    ciphertext: row.payloadCiphertext,
                    keyVersion: row.keyVersion
                })
            )
        } catch {
            return null
        }
    }
}
