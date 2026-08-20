// The signup-call token pair (mirrored for the web bundle in
// @manyfold/shared-cloud): opaque touch tokens the landing page captured.
export interface AcquisitionAttributionTokens {
    firstTouchToken?: string
    lastTouchToken?: string
}

export interface AcquisitionTouch {
    linkId: string
    touchedAt: Date
}

export interface VerifiedTouches {
    first: AcquisitionTouch | null
    last: AcquisitionTouch | null
}

export const NO_TOUCHES: VerifiedTouches = { first: null, last: null }

export const ACQUISITION_PORT = Symbol('ACQUISITION_PORT')

// Growth attribution is a cloud concern; the core auth/agent flows only emit
// events through this port. Every method is fail-soft by contract: attribution
// is bookkeeping and must never block auth, signup or agent creation.
export interface AcquisitionPort {
    resolveTouches(
        tokens: AcquisitionAttributionTokens | null | undefined
    ): Promise<VerifiedTouches>
    // §4.2-a expand: mirror the touch snapshot into cloud-owned storage keyed
    // by the oauth state row, alongside the legacy oauth_states columns the
    // contract step will drop. Fail-soft like everything else here.
    stashOauthTouches(stateId: string, touches: VerifiedTouches): Promise<void>
    // §4.2-a switch: oauth flows pass only oauthStateId (the cloud side owns
    // the snapshot storage); non-oauth flows keep passing touches directly.
    applyUserTouches(args: {
        userId: string
        touches?: VerifiedTouches
        oauthStateId?: string | null
    }): Promise<void>
    recordAccountCreated(args: {
        userId: string
        email: string
        touches?: VerifiedTouches
        oauthStateId?: string | null
    }): Promise<void>
    recordFirstAgentCreated(args: { userId: string }): Promise<void>
}

export const noopAcquisitionPort: AcquisitionPort = {
    resolveTouches: async () => NO_TOUCHES,
    stashOauthTouches: async () => undefined,
    applyUserTouches: async () => undefined,
    recordAccountCreated: async () => undefined,
    recordFirstAgentCreated: async () => undefined
}
