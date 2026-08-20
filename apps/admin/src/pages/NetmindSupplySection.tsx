import type { FC, ReactNode } from 'react'

// Slot (editions §3.2.2 verifier arc): the NetMind supply-side config face
// (key-provision / billing API endpoints, auto-provision switch) is cloud
// commerce surface. The cloud build shadows this file via the admin overlay
// with a self-contained card talking to the managed-models settings endpoint.
const NetmindSupplySection: FC = (): ReactNode => null

export default NetmindSupplySection
