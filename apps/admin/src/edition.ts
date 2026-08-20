// The overlay canary (editions §3.3/§3.4): apps/admin-cloud/src/edition.ts
// shadows this file in cloud builds — the document root carries which edition
// the bundle was built as, and the sentinel stays uniquely greppable.
export const ADMIN_EDITION_SENTINEL = 'mf-admin-edition:self-hosted'
export const ADMIN_EDITION = ADMIN_EDITION_SENTINEL.split(':')[1]
