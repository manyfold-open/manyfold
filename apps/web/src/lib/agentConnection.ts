import type { ApiTokenSummary } from '@manyfold/shared'
import { apiTokenStatus } from '@/lib/apiTokenStatus'

export type AgentConnectionState = 'none' | 'connected' | 'in-use'

export interface AgentConnectionSummary {
    state: AgentConnectionState
    // Live `mf login` sign-ins, newest first.
    signIns: ApiTokenSummary[]
    lastUsedAt: string | null
    firstSignedInAt: string | null
}

// lastUsedAt is written on every authenticated request, so "a request in the
// last 90 seconds" is as close to "your agent is working right now" as the
// server can see. An agent thinking for minutes between calls reads as
// connected, which is why the chip says "In use" and never "Working".
export const IN_USE_WINDOW_MS = 90_000

// A sign-in nobody has used for 30 days is a laptop that went in a drawer,
// not a connection; the chip goes back to offering the setup.
export const STALE_AFTER_MS = 30 * 86_400_000

// Sign-ins minted before the API started tagging them carry no createdVia,
// only the name the CLI exchange gives every token. CLI tokens expire after
// 90 days, so this fallback stops matching anything on its own.
const LEGACY_CLI_NAME = /^mf CLI \d{4}-\d{2}-\d{2}$/

export const isAgentSignIn = (
    token: Pick<ApiTokenSummary, 'createdVia' | 'name' | 'agentId'>
): boolean => {
    if (token.agentId) return false
    if (token.createdVia === 'cli-browser' || token.createdVia === 'cli-poll')
        return true
    return token.createdVia === null && LEGACY_CLI_NAME.test(token.name)
}

const time = (value: string | null): number =>
    value ? new Date(value).getTime() : 0

export const summarizeAgentConnection = (
    tokens: readonly ApiTokenSummary[],
    now: Date = new Date()
): AgentConnectionSummary => {
    const signIns = tokens
        .filter(
            (token) =>
                isAgentSignIn(token) && apiTokenStatus(token, now) === 'active'
        )
        .sort((left, right) => time(right.createdAt) - time(left.createdAt))

    const lastUsed = Math.max(0, ...signIns.map((t) => time(t.lastUsedAt)))
    const lastUsedAt = lastUsed ? new Date(lastUsed).toISOString() : null
    const firstSignedInAt = signIns.length
        ? signIns[signIns.length - 1].createdAt
        : null
    const freshest = Math.max(
        0,
        ...signIns.map((t) => time(t.lastUsedAt ?? t.createdAt))
    )
    const age = now.getTime() - freshest

    const state: AgentConnectionState =
        !signIns.length || age > STALE_AFTER_MS
            ? 'none'
            : lastUsed && now.getTime() - lastUsed <= IN_USE_WINDOW_MS
              ? 'in-use'
              : 'connected'

    return { state, signIns, lastUsedAt, firstSignedInAt }
}

// The setup dialog snapshots which sign-ins already existed when it opened;
// one that was not there then is the agent the user just connected.
export const hasNewSignIn = (
    summary: AgentConnectionSummary,
    knownIds: ReadonlySet<string>
): boolean => summary.signIns.some((token) => !knownIds.has(token.id))
