// The overlay canary (editions §3.3): apps/web-cloud/src/edition.ts shadows
// this file in cloud builds, so the rendered document carries which edition
// the bundle was built as — the cheap, always-on proof that the same-path
// override is actually wired, mirroring the API's edition canary. The
// sentinel prefix keeps the value uniquely greppable in a built bundle.
export const WEB_EDITION_SENTINEL = 'mf-web-edition:self-hosted'
export const WEB_EDITION = WEB_EDITION_SENTINEL.split(':')[1]
