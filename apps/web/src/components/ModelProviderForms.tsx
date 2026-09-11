import type { BuiltInProviderEntry, InferenceProtocol } from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Spinner } from '@/components/Loading'
import { NetmindSignInDialog } from '@/components/NetmindSignInDialog'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'
import { useNetmindConnect } from '@/pages/Settings/managedProviderSlots'
import ModelProviderFields, {
    emptyModelProviderForm
} from '@/pages/Settings/ModelProviderFields'

// The two "add a model provider" forms. Shared by the settings page and the
// agent-create dialog so the same fields save the same way on both; the
// hosts only differ in the chrome around them.

const SaveButton: FC<{ busy: boolean }> = ({ busy }): ReactNode => {
    const { t } = useI18n()
    return (
        <div className='flex justify-end'>
            <button
                type='submit'
                disabled={busy}
                aria-busy={busy}
                className='workbench-button-primary h-9'
            >
                {busy ? (
                    <>
                        <Spinner size={16} className='mr-2' />
                        {t('common.saving')}
                    </>
                ) : (
                    t('web.modelProviders.saveProvider')
                )}
            </button>
        </div>
    )
}

const ErrorBlock: FC<{ error: string | null }> = ({ error }): ReactNode =>
    error ? (
        <div className='workbench-alert-error'>
            <pre className='text-caption whitespace-pre-wrap font-mono'>
                {error}
            </pre>
        </div>
    ) : null

export const BuiltInProviderForm: FC<{
    entry: BuiltInProviderEntry
    onCreated: (id: string) => void
}> = ({ entry, onCreated }): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const [apiKey, setApiKey] = useState('')
    const [name, setName] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const netmindConnect = useNetmindConnect()
    const [connectOpen, setConnectOpen] = useState(false)
    const showConnect = entry.id === 'netmind' && netmindConnect

    useEffect(() => {
        setApiKey('')
        setName('')
        setError(null)
        setConnectOpen(false)
    }, [entry.id])

    const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
            const created = await client.modelProviders.createBuiltIn({
                builtInId: entry.id,
                providerName: name.trim() || undefined,
                apiKey
            })
            onCreated(created.id)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className='space-y-4'>
            {showConnect && (
                <div className='space-y-3'>
                    <button
                        type='button'
                        onClick={() => setConnectOpen(true)}
                        className='workbench-button-primary h-9'
                    >
                        {t('web.modelProviders.connectNetmind')}
                    </button>
                    <p className='text-caption text-muted'>
                        {t('web.modelProviders.netmindHint')}
                    </p>
                    <div
                        className='flex items-center gap-3'
                        role='separator'
                        aria-label={t('web.modelProviders.pasteApiKey')}
                    >
                        <span className='bg-divider h-px flex-1' />
                        <span className='text-caption text-muted'>
                            {t('web.modelProviders.pasteApiKey')}
                        </span>
                        <span className='bg-divider h-px flex-1' />
                    </div>
                </div>
            )}
            <form onSubmit={submit} className='space-y-4'>
                <label className='block'>
                    <span className='workbench-field-label'>
                        {t('web.modelProviders.name')}
                    </span>
                    <input
                        type='text'
                        pattern='^[A-Za-z0-9][A-Za-z0-9_\- .]*$'
                        maxLength={64}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={entry.label}
                        className='workbench-input'
                    />
                    <p className='workbench-hint'>
                        {t('web.modelProviders.optionalNameHint', {
                            provider: entry.label
                        })}
                    </p>
                </label>
                <label className='block'>
                    <span className='workbench-field-label'>
                        {t('web.modelProviders.apiKey')}
                    </span>
                    <input
                        type='password'
                        autoComplete='off'
                        required
                        minLength={10}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={t('web.modelProviders.pasteKey')}
                        className='workbench-input font-mono'
                    />
                </label>
                <ErrorBlock error={error} />
                <SaveButton busy={busy} />
            </form>
            {connectOpen && (
                <NetmindSignInDialog
                    title={t('web.account.connectNetmindTitle')}
                    submitLabel={t('web.account.connect')}
                    description={t(
                        'web.modelProviders.connectNetmindDescription'
                    )}
                    onToken={async (loginToken) => {
                        try {
                            const created =
                                await client.modelProviders.connectNetmind({
                                    loginToken
                                })
                            setConnectOpen(false)
                            onCreated(created.id)
                        } catch (err) {
                            throw new Error(apiErrorMessage(err))
                        }
                    }}
                    onClose={() => setConnectOpen(false)}
                />
            )}
        </div>
    )
}

export const CustomProviderForm: FC<{
    onCreated: (id: string) => void
    // The protocols on offer; the agent-create dialog narrows them to what
    // its framework speaks and starts on the first, the settings page keeps
    // the whole catalog.
    protocols?: readonly InferenceProtocol[]
}> = ({ onCreated, protocols }): ReactNode => {
    const client = useApiClient()
    const [form, setForm] = useState(() => ({
        ...emptyModelProviderForm(),
        ...(protocols?.[0] ? { inferenceProtocol: protocols[0] } : {})
    }))
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
            const created = await client.modelProviders.create({
                inferenceProtocol: form.inferenceProtocol,
                providerName: form.providerName,
                apiKey: form.apiKey,
                baseUrl: form.baseUrl,
                modelsListUrl: form.modelsListUrl || undefined
            })
            onCreated(created.id)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <form onSubmit={submit} className='space-y-4'>
            <ModelProviderFields
                form={form}
                onChange={setForm}
                protocols={protocols}
                onTest={(snapshot) =>
                    client.modelProviders.testInline({
                        inferenceProtocol: snapshot.inferenceProtocol,
                        apiKey: snapshot.apiKey,
                        baseUrl: snapshot.baseUrl,
                        modelsListUrl: snapshot.modelsListUrl
                            ? snapshot.modelsListUrl
                            : undefined
                    })
                }
            />
            <ErrorBlock error={error} />
            <SaveButton busy={busy} />
        </form>
    )
}
