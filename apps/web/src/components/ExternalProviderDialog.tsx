import type {
    ExternalAgentProviderKind,
    UserExternalAgentProviderSummary
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useState } from 'react'
import ProductDialog from '@/components/ProductDialog'
import { Spinner } from '@/components/Loading'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'

const PROVIDER_LABEL: Record<ExternalAgentProviderKind, string> = {
    dify: 'Dify',
    langflow: 'Langflow',
    a2a: 'A2A'
}

const defaultEndpointFor = (kind: ExternalAgentProviderKind): string =>
    kind === 'dify' ? 'https://api.dify.ai/v1' : ''

const endpointPlaceholderFor = (kind: ExternalAgentProviderKind): string =>
    kind === 'langflow'
        ? 'http://your-langflow.example'
        : kind === 'a2a'
          ? 'https://agent.example/.well-known/agent-card.json'
          : 'https://api.dify.ai/v1'

interface Props {
    provider: ExternalAgentProviderKind
    onClose: () => void
    onCreated: (row: UserExternalAgentProviderSummary) => void | Promise<void>
}

const ExternalProviderDialog: FC<Props> = ({
    provider,
    onClose,
    onCreated
}): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const [label, setLabel] = useState('')
    const [endpointUrl, setEndpointUrl] = useState(defaultEndpointFor(provider))
    const [apiKey, setApiKey] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const valid = label.trim().length > 0 && endpointUrl.trim().length > 0

    const submit = async (e: FormEvent): Promise<void> => {
        e.preventDefault()
        if (!valid || busy) return
        setBusy(true)
        setError(null)
        try {
            const url = endpointUrl.trim()
            const test = await client.externalAgentProviders.testInline({
                provider,
                endpointUrl: url,
                apiKey
            })
            if (!test.ok) {
                setError(
                    test.message || t('web.externalProviderDialog.verifyFailed')
                )
                return
            }
            const row = await client.externalAgentProviders.create({
                provider,
                label: label.trim(),
                endpointUrl: url,
                apiKey
            })
            await onCreated(row)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <ProductDialog
            title={t('web.externalProviderDialog.title', {
                provider: PROVIDER_LABEL[provider]
            })}
            description={t('web.externalProviderDialog.desc')}
            size='sm'
            onClose={onClose}
            closeDisabled={busy}
            onSubmit={(e) => void submit(e)}
            bodyClassName='flex flex-col gap-4'
            footer={
                <>
                    <button
                        type='button'
                        onClick={onClose}
                        disabled={busy}
                        className='workbench-button-secondary text-ui h-9 px-3'
                    >
                        {t('web.agentNew.cancel')}
                    </button>
                    <button
                        type='submit'
                        disabled={!valid || busy}
                        className='workbench-button-primary text-ui h-9 gap-1.5 px-4'
                    >
                        {busy ? (
                            <>
                                <Spinner size={16} />
                                {t('web.externalProviderDialog.checking')}
                            </>
                        ) : (
                            t('web.externalProviderDialog.confirm')
                        )}
                    </button>
                </>
            }
        >
            <label className='block'>
                <span className='workbench-field-label mb-1.5 block'>
                    {t('web.externalProviderDialog.nameLabel')}
                </span>
                <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={t('web.externalProviderDialog.namePlaceholder')}
                    className='workbench-input'
                    maxLength={64}
                />
            </label>
            <label className='block'>
                <span className='workbench-field-label mb-1.5 block'>
                    {t('web.externalProviderDialog.endpointLabel')}
                </span>
                <input
                    type='url'
                    value={endpointUrl}
                    onChange={(e) => {
                        setError(null)
                        setEndpointUrl(e.target.value)
                    }}
                    placeholder={endpointPlaceholderFor(provider)}
                    className='workbench-input font-mono'
                    maxLength={1024}
                />
            </label>
            <label className='block'>
                <span className='workbench-field-label mb-1.5 block'>
                    {t('web.externalProviderDialog.apiKeyLabel')}
                </span>
                <input
                    type='password'
                    autoComplete='off'
                    value={apiKey}
                    onChange={(e) => {
                        setError(null)
                        setApiKey(e.target.value)
                    }}
                    className='workbench-input font-mono'
                    maxLength={1024}
                />
            </label>
            {error && <p className='text-error text-caption'>{error}</p>}
        </ProductDialog>
    )
}

export default ExternalProviderDialog
