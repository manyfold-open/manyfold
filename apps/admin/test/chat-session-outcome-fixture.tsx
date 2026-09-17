import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AppAuthProvider } from '@/lib/auth'
import ChatSessionsList from '@/pages/ChatSessions/ChatSessionsList'
import ChatSessionDetail from '@/pages/ChatSessions/ChatSessionDetail'
import '@/styles.css'

createRoot(document.getElementById('root')!).render(
    <AppAuthProvider>
        <BrowserRouter>
            <main className='p-4'>
                <Routes>
                    <Route
                        path='/chat-sessions'
                        element={<ChatSessionsList />}
                    />
                    <Route
                        path='/chat-sessions/:id'
                        element={<ChatSessionDetail />}
                    />
                </Routes>
            </main>
        </BrowserRouter>
    </AppAuthProvider>
)
