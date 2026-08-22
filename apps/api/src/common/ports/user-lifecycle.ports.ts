export const USER_LIFECYCLE_PORT = Symbol('USER_LIFECYCLE_PORT')

// Account-deletion lifecycle (ADR-0023). The core state machine drives
// deactivate → grace → hard delete and DB cascade sweeps every FK row; these
// hooks are where an edition with off-cascade state (commercial rows keyed
// by bare text userId, external billing) cleans up. All hooks must be
// idempotent — the sweep retries them until they succeed.
export interface UserLifecyclePort {
    // T0: the account just entered deletion-pending. A billing edition
    // cancels paid subscriptions here (charging through the grace period is
    // not acceptable).
    onUserDeactivated(userId: string): Promise<void>
    // Grace-period restore. Deliberately NOT a resurrection of anything
    // onUserDeactivated tore down (subscriptions stay canceled).
    onUserReactivated(userId: string): Promise<void>
    // Runs before the core DELETE and MUST succeed for the delete to
    // proceed — failing open would leak rows that no FK ties to the user.
    beforeUserHardDelete(userId: string): Promise<void>
    // V2-B data export (ADR-0023 §9.2): edition-held user data for the
    // takeout bundle. Each entry becomes a `<key>.json` file; the cloud
    // edition contributes a billing summary fetched from the Stripe API
    // (never local financial rows — Stripe is the system of record).
    // Optional so the contract stays additive: an adapter compiled against
    // the three-hook interface keeps working until its edition ships the
    // collector. Whatever it returns still passes the export pipeline's
    // credential redaction — the secret-free guarantee does not trust
    // adapters.
    collectUserExport?(userId: string): Promise<Record<string, unknown>>
}

export const noopUserLifecyclePort: UserLifecyclePort = {
    onUserDeactivated: async () => undefined,
    onUserReactivated: async () => undefined,
    beforeUserHardDelete: async () => undefined,
    collectUserExport: async () => ({})
}
