import {
    ChatMessage,
    SharedChatMessage,
    SharedChatSessionPreview,
    chatCapabilitiesByFramework
} from '@manyfold/shared'
import {
    useCallback,
    useEffect,
    useState,
    type FC,
    type ReactNode
} from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError } from '@manyfold/sdk'
import { BrandMark } from '@/components/Brand'
import MessageList from '@/components/chat/MessageList'
import { FrameworkLogo } from '@/lib/frameworkMeta'
import { SignedIn, SignedOut } from '@/lib/auth'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { formatDate } from '@/lib/dateFormat'
import { loginUrl } from '@/lib/loginRedirect'
import { useI18n } from '@/lib/i18n'

const PAGE_LIMIT = 50

type ViewState =
    | { kind: 'checking' }
    | { kind: 'ok'; preview: SharedChatSessionPreview }
    | { kind: 'not_found' }
    | { kind: 'error'; message: string }

const toChatMessage = (m: SharedChatMessage): ChatMessage => ({
    id: m.id,
    sessionId: '',
    role: m.role,
    contentBlocks: m.contentBlocks,
    createdAt: m.createdAt,
    model: m.model,
    usage: null,
    error: null
})

const SharedChatSession: FC = (): ReactNode => {
    const { t } = useI18n()
    const { shareId } = useParams<{ shareId: string }>()
    const client = useApiClient()
    const [view, setView] = useState<ViewState>({ kind: 'checking' })
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [hasMore, setHasMore] = useState(false)
    const [nextBefore, setNextBefore] = useState<string | null>(null)
    const [loadingOlder, setLoadingOlder] = useState(false)

    // Unlisted links should stay unlisted if one ever leaks into a crawler.
    useEffect(() => {
        const meta = document.createElement('meta')
        meta.name = 'robots'
        meta.content = 'noindex'
        document.head.appendChild(meta)
        return () => {
            meta.remove()
        }
    }, [])

    useEffect(() => {
        let cancelled = false
        if (!shareId) {
            setView({ kind: 'not_found' })
            return
        }
        Promise.all([
            client.chat.resolveShared(shareId),
            client.chat.listSharedMessages(shareId, { limit: PAGE_LIMIT })
        ])
            .then(([preview, page]) => {
                if (cancelled) return
                setMessages(page.messages.map(toChatMessage))
                setHasMore(page.hasMore)
                setNextBefore(page.nextBefore)
                setView({ kind: 'ok', preview })
            })
            .catch((err: unknown) => {
                if (cancelled) return
                if (err instanceof ApiError && err.status === 404) {
                    setView({ kind: 'not_found' })
                    return
                }
                setView({ kind: 'error', message: apiErrorMessage(err) })
            })
        return () => {
            cancelled = true
        }
    }, [shareId, client])

    const loadOlder = useCallback(async (): Promise<void> => {
        if (!shareId || !hasMore || !nextBefore || loadingOlder) return
        setLoadingOlder(true)
        try {
            const page = await client.chat.listSharedMessages(shareId, {
                limit: PAGE_LIMIT,
                before: nextBefore
            })
            setMessages((current) => [
                ...page.messages.map(toChatMessage),
                ...current
            ])
            setHasMore(page.hasMore)
            setNextBefore(page.nextBefore)
        } finally {
            setLoadingOlder(false)
        }
    }, [shareId, hasMore, nextBefore, loadingOlder, client])

    if (view.kind !== 'ok') {
        return (
            <div className='bg-main min-h-dvh'>
                <div className='mx-auto w-full max-w-3xl px-5 py-10'>
                    <Link
                        to='/'
                        aria-label='Manyfold'
                        className='text-fg mb-8 inline-flex items-center gap-2 font-medium'
                    >
                        <BrandMark className='h-6 w-6' />
                        <span>Manyfold</span>
                    </Link>

                    {view.kind === 'checking' && (
                        <div className='workbench-note'>
                            {t('common.loading')}
                        </div>
                    )}

                    {view.kind === 'not_found' && (
                        <div className='workbench-panel px-6 py-8'>
                            <h1 className='text-h1 text-fg'>
                                {t('web.chat.shared.notFoundTitle')}
                            </h1>
                            <p className='text-ui text-muted mt-2'>
                                {t('web.chat.shared.notFoundBody')}
                            </p>
                            <Link
                                to='/'
                                className='workbench-button-secondary mt-5 inline-flex'
                            >
                                {t('web.chat.shared.backHome')}
                            </Link>
                        </div>
                    )}

                    {view.kind === 'error' && (
                        <div className='workbench-alert-error'>
                            {view.message}
                        </div>
                    )}
                </div>
            </div>
        )
    }

    const { preview } = view
    const capabilities = chatCapabilitiesByFramework[preview.agent.framework]

    return (
        <div className='bg-main flex h-dvh flex-col'>
            <header className='border-divider/60 flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 md:px-6'>
                <div className='flex min-w-0 items-center gap-3'>
                    <Link
                        to='/'
                        aria-label='Manyfold'
                        className='text-fg inline-flex shrink-0 items-center gap-2 font-medium'
                    >
                        <BrandMark className='h-6 w-6' />
                    </Link>
                    <div className='min-w-0'>
                        <div className='flex min-w-0 items-center gap-2'>
                            <FrameworkLogo
                                framework={preview.agent.framework}
                                size={16}
                                className='shrink-0'
                            />
                            <h1 className='text-ui text-fg truncate font-medium'>
                                {preview.session.title ??
                                    t('web.chat.shared.untitled')}
                            </h1>
                        </div>
                        <p className='text-caption text-muted mt-0.5 truncate'>
                            {preview.agent.name}
                            {' · '}
                            {preview.sharedBy
                                ? t('web.chat.shared.sharedBy', {
                                      name: preview.sharedBy
                                  })
                                : t('web.chat.shared.sharedAnon')}
                            {' · '}
                            {formatDate(preview.sharedAt)}
                        </p>
                    </div>
                </div>
                <div className='shrink-0'>
                    <SignedIn>
                        <Link
                            to='/workspace'
                            className='workbench-button-primary inline-flex'
                        >
                            {t('web.chat.shared.openApp')}
                        </Link>
                    </SignedIn>
                    <SignedOut>
                        <Link
                            to={loginUrl(`/chat/shared/${shareId ?? ''}`)}
                            className='workbench-button-primary inline-flex'
                        >
                            {t('web.chat.shared.signInCta')}
                        </Link>
                    </SignedOut>
                </div>
            </header>
            <div className='mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col'>
                <MessageList
                    capabilities={capabilities}
                    messages={messages}
                    hasMore={hasMore}
                    loadingOlder={loadingOlder}
                    onLoadOlder={loadOlder}
                    streamingAssistantId={null}
                    streamingBlocks={[]}
                    streamStatus='idle'
                    streamStartedAt={null}
                    streamErrors={[]}
                    framework={preview.agent.framework}
                    editingDisabled
                    disableGrantCards
                />
            </div>
        </div>
    )
}

export default SharedChatSession
