import { isRuntimeUsable } from '@manyfold/shared'
import type { NcaClient, SdkAgent } from '@manyfold/sdk'
import type { TFn } from '@/lib/i18n'

export type TerminalBlockedReason = 'external-runtime' | 'agent-unavailable'

export interface TerminalAvailability {
    available: boolean
    reason: TerminalBlockedReason | null
}

/* The two gates a client can evaluate without a round trip. The sprites
   per-sandbox opt-in is deliberately NOT one of them: `terminalEnabled` lives
   on SandboxSummary, not on the agent, so it costs a request and is resolved
   at activation by ensureSandboxTerminalEnabled instead of hiding the
   control. */
export const terminalAvailabilityForAgent = (
    agent: Pick<SdkAgent, 'runtime' | 'availability'>
): TerminalAvailability => {
    if (agent.runtime === 'external')
        return { available: false, reason: 'external-runtime' }
    if (!isRuntimeUsable(agent.availability))
        return { available: false, reason: 'agent-unavailable' }
    return { available: true, reason: null }
}

export const terminalBlockedLabel = (
    reason: TerminalBlockedReason,
    t: TFn
): string =>
    reason === 'external-runtime'
        ? t('web.terminal.unavailableExternal')
        : t('web.terminal.unavailableAgent')

interface ConfirmOptions {
    title: string
    description: string
    confirmLabel: string
    cancelLabel: string
}

interface EnsureTerminalParams {
    agent: SdkAgent
    client: NcaClient
    confirm: (options: ConfirmOptions) => Promise<boolean>
    t: TFn
}

/* Terminal is opt-in per sandbox (sprites runtime only). Rather than opening
   the terminal and letting the websocket surface a cryptic "terminal is
   disabled" error, ask first and enable on confirm. Returns false only when
   the user declined; an enable failure still proceeds so the websocket
   surfaces the underlying error instead of failing silently. */
export const ensureSandboxTerminalEnabled = async ({
    agent,
    client,
    confirm,
    t
}: EnsureTerminalParams): Promise<boolean> => {
    if (agent.runtime !== 'sprites' || !agent.hostId) return true

    let sandbox = null
    try {
        sandbox = await client.sandboxes.get(agent.hostId)
    } catch {
        sandbox = null
    }

    if (!sandbox || sandbox.terminalEnabled) return true

    const confirmed = await confirm({
        title: t('web.terminal.enablePromptTitle'),
        description: t('web.terminal.enablePromptBody'),
        confirmLabel: t('web.terminal.enablePromptConfirm'),
        cancelLabel: t('web.terminal.enablePromptCancel')
    })
    if (!confirmed) return false

    try {
        await client.sandboxes.setTerminal(sandbox.id, true)
    } catch {}
    return true
}
