import type { FC } from 'react'

export interface SidebarCreditMeterProps {
    collapsed: boolean
}

/* Editions slot. Open source has no billing, so this renders nothing and the
   resource row is just the concurrency chip; the cloud build overlays the file
   with the credit balance chip and its popover.
   Same shape as `signup-gate/SignupGateModal` — a slot the superproject fills
   by path, so the shell keeps one layout instead of forking for an edition. */
const SidebarCreditMeter: FC<SidebarCreditMeterProps> = () => null

export default SidebarCreditMeter
