import type { Command } from 'commander'

// Commander parses non-positionally: the root program consumes its global
// `--agent-id` from anywhere on the command line, including after a
// subcommand. A subcommand-local `--agent-id` declaration therefore never
// receives a value — it exists as help surface only. Every agent-aware
// action must resolve the agent through these helpers so the flag works in
// any position and `$MF_AGENT_ID` behaves identically across commands.
// Precedence: subcommand flag (in case positional parsing is ever enabled)
// > root flag > env. test/global-option-shadowing.test.ts enforces that no
// subcommand redefines a root option without routing through this module.
export const resolveOptionalAgentId = (
    localAgentId: string | undefined,
    program: Command
): string | undefined => {
    const root = program.opts<{ agentId?: string }>()
    const id = localAgentId ?? root.agentId ?? process.env.MF_AGENT_ID
    const trimmed = id?.trim()
    return trimmed ? trimmed : undefined
}

export const resolveAgentId = (
    localAgentId: string | undefined,
    program: Command
): string => {
    const id = resolveOptionalAgentId(localAgentId, program)
    if (!id)
        throw new Error(
            'agent id is required: pass --agent-id, set $MF_AGENT_ID, or use the global --agent-id option'
        )
    return id
}
