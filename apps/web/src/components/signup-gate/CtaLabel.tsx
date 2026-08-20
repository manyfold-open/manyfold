import type { FC } from 'react'

// Editions slot (§3.3): the request-access CTA label. Its buttons only render
// inside gate-enabled branches, which the open-source build never enters;
// the cloud overlay shadows this with the translated label.
const GateCtaLabel: FC = () => null

export default GateCtaLabel
