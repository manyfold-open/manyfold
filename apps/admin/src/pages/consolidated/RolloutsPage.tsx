import type { FC, ReactNode } from 'react'
import FeatureTogglesSettingsPage from '@/pages/FeatureTogglesSettings'
import { TabbedPage } from '@/pages/consolidated/TabbedPage'
import { adminRoutes } from '@/routes'

// Editions slot (§3.4): feature flags are core; the experiments tab is the
// cloud overlay's addition.
export const RolloutsPage: FC<{
    view: 'experiments' | 'features'
}> = (): ReactNode => {
    return (
        <TabbedPage
            activeId='features'
            ariaLabel='Rollout controls'
            tabs={[
                {
                    id: 'features',
                    label: 'Feature flags',
                    to: adminRoutes.rolloutFeatureFlags
                }
            ]}
        >
            <FeatureTogglesSettingsPage />
        </TabbedPage>
    )
}
