import type { FC } from 'react'

// Editions slot (§3.3): cloud overlay shadows this with the real gate; the
// open-source build has open signup, so there is nothing to gate.
interface AccessGateModalProps {
    open: boolean
    onClose: () => void
    onRequestAccess: () => void
}

const AccessGateModal: FC<AccessGateModalProps> = () => null

export default AccessGateModal
