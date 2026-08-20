import type { FC, ReactNode } from 'react'
import type { UserModelProviderSummary } from '@manyfold/shared'

// Editions slots (§3.3) for the providers page's managed surface. The open
// source build has no managed supply: the hook reports no account, the
// panels render nothing, and the page's managed branches stay dead. The
// cloud overlay ships the real state bundle and panels.

export type ManagedProviderState = null

export const useManagedProviderAccount = (): {
    state: ManagedProviderState
    hasAccount: boolean
    refresh: () => Promise<void>
} => ({ state: null, hasAccount: false, refresh: async () => {} })

export const ManagedView: FC<{
    rows: UserModelProviderSummary[]
    state: ManagedProviderState
    onChanged: () => void
}> = (): ReactNode => null

export const SidebarManagedRow: FC<{
    rows: UserModelProviderSummary[]
    state: ManagedProviderState
    q: string
    selected: boolean
    onClick: () => void
}> = (): ReactNode => null

export const NetmindRowExtras: FC<{
    row: UserModelProviderSummary
}> = (): ReactNode => null

// Whether the NetMind sign-in connect path is available (needs the cloud
// key-provisioning verifier).
export const useNetmindConnect = (): boolean => false
