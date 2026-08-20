import { validateAgentName } from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import SettingsPageHeader from '@/components/SettingsPageHeader'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'

const SandboxNew: FC = (): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const navigate = useNavigate()

    const [name, setName] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    // Name is optional: blank auto-names sandbox-NNN server-side. Only validate
    // (and block) once the user has actually typed something.
    const trimmed = name.trim()
    const nameValidation = validateAgentName(name)
    const nameValidationMessage =
        trimmed.length === 0 || nameValidation.valid
            ? null
            : nameValidation.message
    const canSubmit = !busy && (trimmed.length === 0 || nameValidation.valid)

    const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
        e.preventDefault()
        if (!canSubmit) return
        setBusy(true)
        setError(null)
        try {
            const created = await client.sandboxes.create(
                nameValidation.valid ? { name: nameValidation.value } : {}
            )
            navigate(
                `/settings/runtimes?host=${encodeURIComponent(`sprite:${created.id}`)}`
            )
        } catch (err) {
            setError(apiErrorMessage(err))
            setBusy(false)
        }
    }

    return (
        <div className='settings-page'>
            <SettingsPageHeader
                breadcrumb={[
                    { label: t('web.settingsLayout.runtimes'), to: '/settings/runtimes' },
                    { label: t('web.sandboxNew.title') }
                ]}
                title={t('web.sandboxNew.title')}
            />
            <div className='mb-8 inline-flex items-center gap-2'>
                <span className='tag tag-neutral'>{t('web.sandboxNew.tag')}</span>
                <span className='text-caption text-subtle'>
                    {t('web.sandboxNew.subtitle')}
                </span>
            </div>

            <div className='workbench-panel p-6 md:p-7'>
                <form onSubmit={submit} className='space-y-6'>
                    <label className='block'>
                        <span className='workbench-field-label'>
                            {t('web.sandboxNew.nameLabel')}
                        </span>
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder={t('web.sandboxNew.namePlaceholder')}
                            className='workbench-input'
                        />
                        <p className='workbench-hint'>
                            {t('web.sandboxNew.nameHint')}
                        </p>
                        {nameValidationMessage && (
                            <p className='text-caption text-accent-ruby mt-1'>
                                {nameValidationMessage}
                            </p>
                        )}
                    </label>

                    {error && (
                        <div className='workbench-alert-error'>
                            <pre className='text-caption font-mono whitespace-pre-wrap'>
                                {error}
                            </pre>
                        </div>
                    )}

                    <button
                        type='submit'
                        disabled={!canSubmit}
                        className='workbench-button-primary h-11 w-full'
                    >
                        {busy ? t('web.sandboxNew.creating') : t('web.sandboxNew.create')}
                    </button>
                </form>
            </div>
        </div>
    )
}

export default SandboxNew
