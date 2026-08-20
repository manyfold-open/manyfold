import { adminRoutes } from '@/routes'

// Slot (editions §3.4): where /platform/rollouts lands. The open-source
// rollouts surface is feature toggles; the cloud overlay shadows this with
// the experiments tab so the pre-split landing order is preserved.
export const rolloutsHomeRoute = adminRoutes.rolloutFeatureFlags
