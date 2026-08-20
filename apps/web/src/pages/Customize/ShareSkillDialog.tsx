import type { ShareLibrarySkillResult } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import ProductDialog from '@/components/ProductDialog'
import { useApiClient } from '@/lib/apiClient'
import { SheenText, Spinner } from '@/components/Loading'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'

const shareUrlFor = (shareId: string): string =>
    `${window.location.origin}/skills/shared/${shareId}`

interface Props {
    skillId: string
    name: string
    onClose: () => void
}

const ShareSkillDialog: FC<Props> = ({ skillId, name, onClose }): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [share, setShare] = useState<ShareLibrarySkillResult | null>(null)
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState(false)
    const [copied, setCopied] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        client.skills.library
            .getShare(skillId)
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
    }, [client, skillId])

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
            setShare(await client.skills.library.share(skillId))
        })

    const revokeLink = (): Promise<void> =>
        run(async () => {
            await client.skills.library.revokeShare(skillId)
            setShare(null)
        })

    const resetLink = (): Promise<void> =>
        run(async () => {
            await client.skills.library.revokeShare(skillId)
            setShare(await client.skills.library.share(skillId))
        })

    const copyLink = async (): Promise<void> => {
        if (!share) return
        try {
            await navigator.clipboard.writeText(shareUrlFor(share.id))
            setCopied(true)
            window.setTimeout(() => setCopied(false), 2000)
        } catch {
            setError(t('web.skills.library.shareCopyFailed'))
        }
    }

    return (
        <ProductDialog
            title={t('web.skills.library.shareTitle', { name })}
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
                        {t('web.skills.library.shareIntro')}
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
                            t('web.skills.library.shareCreate')
                        )}
                    </button>
                </div>
            )}

            {!loading && share && (
                <div className='space-y-4'>
                    <p className='text-ui text-muted'>
                        {t('web.skills.library.shareActiveHint')}
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
                                ? t('web.skills.library.shareCopied')
                                : t('web.skills.library.shareCopy')}
                        </button>
                    </div>
                    <p className='text-caption text-muted'>
                        {t('web.skills.library.shareImportCount', {
                            count: share.importCount
                        })}
                    </p>
                    <div className='flex flex-wrap gap-2'>
                        <button
                            type='button'
                            disabled={busy}
                            onClick={() => void resetLink()}
                            className='workbench-button-secondary'
                        >
                            {t('web.skills.library.shareReset')}
                        </button>
                        <button
                            type='button'
                            disabled={busy}
                            onClick={() => void revokeLink()}
                            className='workbench-button-danger'
                        >
                            {t('web.skills.library.shareRevoke')}
                        </button>
                    </div>
                </div>
            )}
        </ProductDialog>
    )
}

export default ShareSkillDialog
