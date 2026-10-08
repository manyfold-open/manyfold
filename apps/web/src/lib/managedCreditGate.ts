// Editions slot (§3.3): the agent-create credit gate reflects the managed
// provider account (signup credit, balance, key provisioning). Open source
// has no managed supply: the gate reports "not available" and every credit
// branch in AgentNew stays dead. The cloud overlay polls the real account.
import type { FC } from 'react'

export interface ManagedCreditGrantView {
    status: string
    amount: number
}

export interface ManagedCreditGate {
    managedAvailable: boolean
    phase: 'loading' | 'pending' | 'ready' | 'error'
    balance: number | null
    creditGrant: ManagedCreditGrantView | null
    retry: () => void
    // The edition's own dialog for adding credit, so a create flow that finds
    // no balance can offer one in place instead of sending the user to
    // billing. Absent where there is nothing to buy.
    AddCreditDialog?: FC<{ balance: number | null; onClose: () => void }>
}

export const useManagedCreditGate = (): ManagedCreditGate => ({
    managedAvailable: false,
    phase: 'ready',
    balance: null,
    creditGrant: null,
    retry: () => {}
})
