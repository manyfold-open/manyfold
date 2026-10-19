import type { RuntimeProviderSummary } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { t } from '@manyfold/i18n'
import { adminRoutes } from '@/routes'
import { AdminPageTabs, Breadcrumbs, Heading } from '@/ui'

// The top of a runtime provider's pages: where it sits, its name, and its
// sections when its kind lists an inventory.
export const RuntimeProviderHeader: FC<{
    providerId: string
    provider: RuntimeProviderSummary | null
    active: 'settings' | 'inventory'
}> = ({ providerId, provider, active }): ReactNode => (
    <>
        <Breadcrumbs
            items={[
                {
                    label: t('admin.nav.runtimeProviders'),
                    to: adminRoutes.runtimeProviders
                },
                { label: provider?.name ?? providerId }
            ]}
        />
        <Heading level={2} className='mb-2'>
            {provider?.name ?? providerId}
        </Heading>
        {provider?.capabilities.inventory && (
            <AdminPageTabs
                activeId={active}
                ariaLabel={t('admin.runtimeProviders.tabs.label')}
                tabs={[
                    {
                        id: 'settings',
                        label: t('admin.runtimeProviders.tabs.settings'),
                        to: adminRoutes.runtimeProvider(providerId)
                    },
                    {
                        id: 'inventory',
                        label: t('admin.runtimeProviders.tabs.inventory'),
                        to: adminRoutes.runtimeProviderInventory(providerId)
                    }
                ]}
            />
        )}
    </>
)
