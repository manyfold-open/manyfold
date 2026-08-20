import type { NavGroup, NavItem } from '@/components/AppLayout'

// Editions slot (§3.4): nav contributions from the composition layer. Empty
// in the open-source build; the cloud overlay shadows this module with the
// commercial groups (campaign, growth) and per-group items (container SKUs,
// billing).
export const extraNavGroupItems: Record<string, NavItem[]> = {}

export const extraNavGroups: Array<{
    insertAfter: string
    group: NavGroup
}> = []
