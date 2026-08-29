// Editions slot (§3.3): what the composition layer adds to this build.
//
// Billing — plans, pricing, container purchase — is a cloud surface. The
// open-source API has no billing routes, and every page under
// /settings/plan-and-billing is a stub that redirects to /settings. Anything
// that would link into that area has to check this first, or a self-hosted
// user gets a control that bounces them back where they started.
//
// apps/web-cloud/src/edition-capabilities.ts shadows this file with `true`.
// A build-time constant, not a runtime flag: the overlay is a build-time
// swap, so the branches the edition cannot reach drop out of the bundle.
export const BILLING_SURFACE = false
