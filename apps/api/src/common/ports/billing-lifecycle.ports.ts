export const BILLING_LIFECYCLE_PORT = Symbol('BILLING_LIFECYCLE_PORT')

// Fired after register/login so the billing edition can provision payment
// state eagerly (idempotent, fire-and-forget from the caller's perspective).
// The open-source default has no billing to provision.
export interface BillingLifecyclePort {
    onUserProvisioned(userId: string): Promise<void>
}

export const noopBillingLifecyclePort: BillingLifecyclePort = {
    onUserProvisioned: async () => undefined
}
