import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AppAuthProvider } from '@/lib/auth'
import ProviderInventory from '@/pages/RuntimeProviders/ProviderInventory'
import ProviderMachineDetail from '@/pages/RuntimeProviders/ProviderMachineDetail'
import { adminRoutes } from '@/routes'
import '@/styles.css'

createRoot(document.getElementById('root')!).render(
    <AppAuthProvider>
        <BrowserRouter>
            <main className='p-4'>
                <Routes>
                    <Route
                        path={adminRoutes.runtimeProviderInventoryDetail}
                        element={<ProviderInventory />}
                    />
                    <Route
                        path={adminRoutes.runtimeProviderMachineDetail}
                        element={<ProviderMachineDetail />}
                    />
                </Routes>
            </main>
        </BrowserRouter>
    </AppAuthProvider>
)
