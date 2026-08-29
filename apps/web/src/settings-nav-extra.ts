import type { SettingsNavItem } from '@/components/SettingsLayout'

// Editions slot (§3.4, mirroring apps/admin/src/nav-extra.ts): settings-rail
// contributions from the composition layer. Empty in the open-source build —
// billing is a cloud surface, and the open-source Plan & billing page is a
// slot that redirects, so listing it in the rail offered a link that bounced
// straight back. The cloud overlay shadows this module with the real entry.
export const extraSettingsNavItems: SettingsNavItem[] = []
