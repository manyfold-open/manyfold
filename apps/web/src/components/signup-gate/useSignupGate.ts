// Editions slot (§3.3): the open-source build has open signup, so the
// gate feature is permanently disabled and settled — no fetch, no flash.
// The cloud overlay shadows this module with the probing implementation.
export interface SignupGateFeature {
    loaded: boolean
    enabled: boolean
}

export const useSignupGateFeature = (): SignupGateFeature => ({
    loaded: true,
    enabled: false
})
