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
}

export const noopUserLifecyclePort: UserLifecyclePort = {
    onUserDeactivated: async () => undefined,
    onUserReactivated: async () => undefined,
    beforeUserHardDelete: async () => undefined
}
