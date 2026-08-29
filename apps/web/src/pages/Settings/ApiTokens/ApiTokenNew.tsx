import type { ApiTokenScope } from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Breadcrumb from '@/components/Breadcrumb'
import { CopyIcon } from '@/components/icons'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'

type ExpiryOption = 'never' | '30' | '90' | '365'

const ApiTokenNew: FC<{ onCreated: () => Promise<void> }> = ({
    onCreated
}): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const navigate = useNavigate()
    const [name, setName] = useState('')
    const [scope, setScope] = useState<ApiTokenScope>('chat.completions')
    const [expiry, setExpiry] = useState<ExpiryOption>('never')
    const [issued, setIssued] = useState<{ token: string; id: string } | null>(
        null
    )
    const [copied, setCopied] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
        e.preventDefault()
        const trimmed = name.trim()
        if (!trimmed) return
        setBusy(true)
        setError(null)
        try {
            const res = await client.apiTokens.create({
                name: trimmed,
                scopes: [scope],
                expiresInDays: expiry === 'never' ? null : Number(expiry)
            })
            setIssued({ token: res.token, id: res.summary.id })
            await onCreated()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const copy = async (): Promise<void> => {
        if (!issued) return
        await navigator.clipboard.writeText(issued.token)
        setCopied(true)
    }

    return (
        <div className='mx-auto w-full max-w-3xl px-5 py-6 md:px-6 md:py-7'>
            <div className='mb-4'>
                <Breadcrumb
                    items={[
                        {
                            label: t('web.apiTokens.title'),
                            to: '/settings/api-tokens'
                        },
                        { label: t('web.apiTokens.createTitle') }
                    ]}
                />
            </div>

            <div className='workbench-panel p-6 md:p-7'>
                {issued ? (
                    // The plaintext is returned exactly once, so it lives here
                    // until the page is left — navigating away is what clears
                    // it, which is the property the old inline block lacked.
                    <div className='space-y-4'>
                        <div>
                            <h2 className='text-h3 text-fg tracking-tight'>
                                {t('web.apiTokens.issuedTitle')}
                            </h2>
                            <p className='text-caption text-muted mt-1'>
                                {t('web.apiTokens.copyDescription')}
                            </p>
                        </div>
                        <code className='bg-surface-subtle shadow-ring-light block break-all rounded-sm p-3 font-mono'>
                            {issued.token}
                        </code>
                        <div className='flex flex-wrap items-center gap-2'>
                            <button
                                type='button'
                                onClick={() => void copy()}
                                className='workbench-button-secondary h-9 gap-1.5 px-3'
                            >
                                <CopyIcon className='h-3.5 w-3.5' />
                                {copied
                                    ? t('web.apiTokens.copied')
                                    : t('web.apiTokens.copy')}
                            </button>
                            <span className='min-w-2 flex-1' />
                            <button
                                type='button'
                                onClick={() =>
                                    navigate(
                                        `/settings/api-tokens/${issued.id}`
                                    )
                                }
                                className='workbench-button-primary h-9'
                            >
                                {t('web.apiTokens.done')}
                            </button>
                        </div>
                    </div>
                ) : (
                    <form onSubmit={submit} className='space-y-4'>
                        {error && (
                            <div className='workbench-alert-error'>{error}</div>
                        )}
                        <label className='block'>
                            <span className='text-ui text-fg mb-1 block font-medium'>
                                {t('web.apiTokens.nameLabel')}
                            </span>
                            <input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder={t('web.apiTokens.namePlaceholder')}
                                className='workbench-input'
                                required
                            />
                        </label>
                        <label className='block'>
                            <span className='text-ui text-fg mb-1 block font-medium'>
                                {t('web.apiTokens.scopeLabel')}
                            </span>
                            <WorkbenchSelect
                                ariaLabel={t('web.apiTokens.scopeLabel')}
                                value={scope}
                                onChange={(next) =>
                                    setScope(next as ApiTokenScope)
                                }
                                options={[
                                    {
                                        value: 'chat.completions',
                                        label: t('web.apiTokens.scopeChat')
                                    },
                                    {
                                        value: 'api.full',
                                        label: t('web.apiTokens.scopeFull')
                                    }
                                ]}
                            />
                        </label>
                        <label className='block'>
                            <span className='text-ui text-fg mb-1 block font-medium'>
                                {t('web.apiTokens.expiryLabel')}
                            </span>
                            <WorkbenchSelect
                                ariaLabel={t('web.apiTokens.expiryLabel')}
                                value={expiry}
                                onChange={(next) =>
                                    setExpiry(next as ExpiryOption)
                                }
                                options={[
                                    {
                                        value: 'never',
                                        label: t('web.apiTokens.expiryNever')
                                    },
                                    {
                                        value: '30',
                                        label: t('web.apiTokens.expiryDays', {
                                            days: 30
                                        })
                                    },
                                    {
                                        value: '90',
                                        label: t('web.apiTokens.expiryDays', {
                                            days: 90
                                        })
                                    },
                                    {
                                        value: '365',
                                        label: t('web.apiTokens.expiryDays', {
                                            days: 365
                                        })
                                    }
                                ]}
                            />
                        </label>
                        <div className='flex justify-end gap-2 pt-2'>
                            <button
                                type='button'
                                onClick={() => navigate('/settings/api-tokens')}
                                className='workbench-button-secondary h-9'
                                disabled={busy}
                            >
                                {t('common.cancel')}
                            </button>
                            <button
                                type='submit'
                                className='workbench-button-primary h-9'
                                disabled={busy || !name.trim()}
                            >
                                {busy
                                    ? t('common.creating')
                                    : t('web.apiTokens.create')}
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </div>
    )
}

export default ApiTokenNew
