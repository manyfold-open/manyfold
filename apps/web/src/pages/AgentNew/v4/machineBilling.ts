import type {
    AgentCredentialsView,
    UserModelProviderSummary
} from '@manyfold/shared'

// What a runtime already pays with at the account level. The credential is
// stored once per runtime, not per agent, so reading it through any one agent
// on the runtime answers for all of them.
//
// Seen on staging [2026-10-08]: step ③ on a sandbox running six Claude Code
// agents offered "Manyfold managed" with no sign of what those six used, and
// picking it rewrote the runtime's credential under all of them. Knowing the
// current payer is what lets step ③ offer keeping it.
export type MachineBilling =
    | { kind: 'managed' }
    | { kind: 'provider'; providerId: string; label: string }
    // A key that matches no saved provider: pasted at create, or its row
    // deleted since.
    | { kind: 'key' }

export const machineBillingFrom = (
    view: AgentCredentialsView,
    providers: readonly UserModelProviderSummary[]
): MachineBilling | null => {
    // A daemon keeps its sign-in on the machine itself, and a framework
    // configured in its own UI keeps nothing here: neither has an
    // account-level payer to keep.
    if (view.unsupported === true || view.localManaged === true) return null
    const saved = view.savedProvider
    if (saved !== null) {
        const row = providers.find((p) => p.id === saved.id)
        return row?.source === 'managed'
            ? { kind: 'managed' }
            : {
                  kind: 'provider',
                  providerId: saved.id,
                  label: saved.providerName
              }
    }
    return view.apiKeyMasked !== null ? { kind: 'key' } : null
}
