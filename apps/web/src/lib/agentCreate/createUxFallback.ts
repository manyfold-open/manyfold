// Editions slot (§3.3): the create-agent form this build opens when no
// experiment assignment applies. A/B assignment is cloud-side operations
// tooling and a self-hosted API always answers `/auth/me` with an empty
// assignment map, so here the fallback is the whole selection rather than a
// stopgap: this edition opens the classic form. The cloud overlay shadows
// this with the variant its own experiment falls back to.
//
// Typed as `string` because the two editions hold different literals: a
// consumer comparing this against a variant id has to typecheck in both.
export const AGENT_CREATE_UX_FALLBACK: string = 'v1'
