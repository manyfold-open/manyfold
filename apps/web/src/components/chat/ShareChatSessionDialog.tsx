import type { ShareChatSessionResult } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import ProductDialog from '@/components/ProductDialog'
import { useApiClient } from '@/lib/apiClient'
import { SheenText, Spinner } from '@/components/Loading'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'

const shareUrlFor = (shareId: string): string =>
    `${window.location.origin}/chat/shared/${shareId}`

interface Props {
    agentId: string
    sessionId: string
    title: string | null
    onClose: () => void
}

const ShareChatSessionDialog: FC<Props> = ({
    agentId,
    sessionId,
    title,
    onClose
}): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [share, setShare] = useState<ShareChatSessionResult | null>(null)
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState(false)
    const [copied, setCopied] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        client.chat
            .getSessionShare(agentId, sessionId)
            .then((result) => {
                if (cancelled) return
                setShare(result.share)
                setError(null)
            })
            .catch((err: unknown) => {
                if (!cancelled) setError(apiErrorMessage(err))
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [client, agentId, sessionId])

    const run = async (action: () => Promise<void>): Promise<void> => {
        if (busy) return
        setBusy(true)
        setError(null)
        setCopied(false)
        try {
            await action()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const createLink = (): Promise<void> =>
        run(async () => {
            setShare(await client.chat.shareSession(agentId, sessionId))
        })

    const revokeLink = (): Promise<void> =>
        run(async () => {
            await client.chat.revokeSessionShare(agentId, sessionId)
            setShare(null)
        })

    const resetLink = (): Promise<void> =>
        run(async () => {
            await client.chat.revokeSessionShare(agentId, sessionId)
            setShare(await client.chat.shareSession(agentId, sessionId))
        })

    const copyLink = async (): Promise<void> => {
        if (!share) return
        try {
            await navigator.clipboard.writeText(shareUrlFor(share.id))
            setCopied(true)
            window.setTimeout(() => setCopied(false), 2000)
        } catch {
            setError(t('web.chat.share.copyFailed'))
        }
    }

    return (
        <ProductDialog
            title={t('web.chat.share.title', {
                name: title ?? t('web.chat.share.untitledSession')
            })}
            onClose={onClose}
            closeDisabled={busy}
            footer={
                <button
                    type='button'
                    onClick={onClose}
                    disabled={busy}
                    className='workbench-button-secondary'
                >
                    {t('common.close')}
                </button>
            }
        >
            {error && <div className='workbench-alert-error mb-4'>{error}</div>}

            {loading && (
                <SheenText className='text-ui text-muted'>
                    {t('common.loading')}
                </SheenText>
            )}

            {!loading && !share && (
                <div className='space-y-4'>
                    <p className='text-ui text-muted'>
                        {t('web.chat.share.intro')}
                    </p>
                    <button
                        type='button'
                        disabled={busy}
                        onClick={() => void createLink()}
                        className='workbench-button-primary'
                    >
                        {busy ? (
                            <>
                                <Spinner size={16} className='mr-2' />
                                {t('common.creating')}
                            </>
                        ) : (
                            t('web.chat.share.create')
                        )}
                    </button>
                </div>
            )}

            {!loading && share && (
                <div className='space-y-4'>
                    <p className='text-ui text-muted'>
                        {t('web.chat.share.activeHint')}
                    </p>
                    <div className='flex items-center gap-2'>
                        <input
                            readOnly
                            value={shareUrlFor(share.id)}
                            onFocus={(event) => event.target.select()}
                            className='workbench-input flex-1 font-mono'
                        />
                        <button
                            type='button'
                            onClick={() => void copyLink()}
                            className='workbench-button-secondary shrink-0'
                        >
                            {copied
                                ? t('web.chat.share.copied')
                                : t('web.chat.share.copy')}
                        </button>
                    </div>
                    <div className='flex flex-wrap gap-2'>
                        <button
                            type='button'
                            disabled={busy}
                            onClick={() => void resetLink()}
                            className='workbench-button-secondary'
                        >
                            {t('web.chat.share.reset')}
                        </button>
                        <button
                            type='button'
                            disabled={busy}
                            onClick={() => void revokeLink()}
                            className='workbench-button-danger'
                        >
                            {t('web.chat.share.revoke')}
                        </button>
                    </div>
                </div>
            )}
        </ProductDialog>
    )
}

export default ShareChatSessionDialog
