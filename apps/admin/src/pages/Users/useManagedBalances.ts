// Slot (editions §3.4): per-user managed-provider balances are a cloud
// commerce enrichment of the users table. The cloud overlay shadows this
// hook with one that actually fetches; here it reports "no balances" and
// the ` · bal ` fragment never renders.
export const useManagedBalances = (): Map<string, number | null> | null =>
    null
