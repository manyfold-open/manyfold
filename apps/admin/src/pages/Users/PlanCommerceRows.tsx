import type { RuntimeAccessSummary } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'

// Editions slot: the plan card's commerce rows (price, subscription status,
// managed spend). Plans have no prices on a self-hosted deployment; the
// cloud overlay shadows this with the data-fetching rows.
const PlanCommerceRows: FC<{
    userId: string
    planUsage: RuntimeAccessSummary
}> = (): ReactNode => null

export const ManagedSpendRows: FC<{ userId: string }> = (): ReactNode => null

export default PlanCommerceRows
