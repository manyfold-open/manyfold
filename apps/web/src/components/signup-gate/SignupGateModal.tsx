import type { FC } from 'react'

// Editions slot (§3.3): gated signup is a cloud feature. This open-source
// stub renders nothing — the cloud overlay shadows it with the real modal —
// and useSignupGate() is permanently disabled here, so nothing opens it.
interface SignupGateModalProps {
    open: boolean
    onClose: () => void
}

const SignupGateModal: FC<SignupGateModalProps> = () => null

export default SignupGateModal
