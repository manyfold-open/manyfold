import type { FC, ReactNode } from 'react'
import ModelProvidersList from '@/pages/ModelProviders/ModelProvidersList'
import BuiltInModelPricesPage from '@/pages/ModelProviders/BuiltInModelPricesPage'
import { TabbedPage } from '@/pages/consolidated/TabbedPage'
import { adminRoutes } from '@/routes'

// Editions slot (§3.4): BYO provider keys and built-in prices are core; the
// managed channel/catalog tabs are the cloud overlay's addition.
export const ModelProvidersPage: FC<{
    view: 'keys' | 'channels' | 'models' | 'built-in-prices'
}> = ({ view }): ReactNode => {
    return (
        <TabbedPage
            activeId={view === 'built-in-prices' ? view : 'keys'}
            ariaLabel='Model provider settings'
            tabs={[
                {
                    id: 'keys',
                    label: 'Provider keys',
                    to: adminRoutes.modelProviderKeys
                },
                {
                    id: 'built-in-prices',
                    label: 'Built-in prices',
                    to: adminRoutes.modelProviderBuiltInPrices
                }
            ]}
        >
            {view === 'built-in-prices' ? (
                <BuiltInModelPricesPage />
            ) : (
                <ModelProvidersList />
            )}
        </TabbedPage>
    )
}
