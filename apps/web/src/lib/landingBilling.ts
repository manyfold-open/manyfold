import type { PlanId } from '@manyfold/shared'

// Editions slot (§3.3): the landing pricing cards' purchase wiring is a
// cloud commerce surface. Open source reports no billing context, so the
// cards fall back to the plain sign-in flow; the cloud overlay wires
// subscribe/portal.
export interface PricingBilling {
    currentPlanId: PlanId | null
    isPaid: boolean
    busy: boolean
    onSelect: (planId: PlanId) => void
}

export const useSignedInBilling = (): {
    billing: PricingBilling | null
    actionError: string | null
} => ({ billing: null, actionError: null })
