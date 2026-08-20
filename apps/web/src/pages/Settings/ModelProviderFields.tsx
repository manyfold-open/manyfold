import {
    INFERENCE_PROTOCOLS,
    InferenceProtocol,
    ProviderTestResult,
    UserModelProvider
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import ProviderTestResultBanner from '@/pages/Settings/ProviderTestResultBanner'
import { useI18n } from '@/lib/i18n'

export const providerLabel: Record<UserModelProvider, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    openrouter: 'OpenRouter',
    google: 'Google Gemini',
    antigravity: 'Antigravity',
    antigravity_claude: 'Antigravity Claude'
}

export const inferenceProtocolLabel: Record<InferenceProtocol, string> = {
    anthropic_messages: 'Anthropic Msg',
    openai_chat_completions: 'OpenAI Chat',
    openai_responses: 'OpenAI Resp',
    google_generate_content: 'Google Gen',
    mistral_chat_completions: 'Mistral Chat'
}

export interface ModelProviderFormState {
    mode: 'create' | 'edit'
    id?: string
    builtInId?: string | null
    inferenceProtocol: InferenceProtocol
    providerName: string
    apiKey: string
    baseUrl: string
    modelsListUrl: string
}

export const emptyModelProviderForm = (): ModelProviderFormState => ({
    mode: 'create',
    builtInId: null,
    inferenceProtocol: 'openai_chat_completions',
    providerName: '',
    apiKey: '',
    baseUrl: '',
    modelsListUrl: ''
})

interface Props {
    form: ModelProviderFormState
    onChange: (next: ModelProviderFormState) => void
    onTest?: (snapshot: {
        inferenceProtocol: InferenceProtocol
        apiKey: string
        baseUrl: string
        modelsListUrl: string
    }) => Promise<ProviderTestResult>
}

const ModelProviderFields: FC<Props> = ({
    form,
    onChange,
    onTest
}): ReactNode => {
    const { t } = useI18n()
    const [testing, setTesting] = useState(false)
    const [result, setResult] = useState<ProviderTestResult | null>(null)
    const [testError, setTestError] = useState<string | null>(null)

    const canTest =
        !!onTest &&
        form.apiKey.trim().length >= 10 &&
        form.baseUrl.trim().length > 0

    const runTest = async (): Promise<void> => {
        if (!onTest) return
        setTesting(true)
        setTestError(null)
        setResult(null)
        try {
            const r = await onTest({
                inferenceProtocol: form.inferenceProtocol,
                apiKey: form.apiKey,
                baseUrl: form.baseUrl,
                modelsListUrl: form.modelsListUrl
            })
            setResult(r)
        } catch (err) {
            setTestError((err as Error).message)
        } finally {
            setTesting(false)
        }
    }

    return (
        <>
            <div className='grid gap-4 md:grid-cols-2'>
                <div className='block'>
                    <span className='workbench-field-label'>
                        {t('web.modelProviderFields.inferenceProtocol')}
                    </span>
                    <WorkbenchSelect
                        ariaLabel={t('web.modelProviderFields.inferenceProtocol')}
                        value={form.inferenceProtocol}
                        onChange={(next) =>
                            onChange({
                                ...form,
                                inferenceProtocol: next as InferenceProtocol
                            })
                        }
                        options={INFERENCE_PROTOCOLS.map((protocol) => ({
                            value: protocol,
                            label: inferenceProtocolLabel[protocol]
                        }))}
                    />
                </div>
                <label className='block'>
                    <span className='workbench-field-label'>{t('web.modelProviderFields.providerName')}</span>
                    <input
                        required
                        pattern='^[A-Za-z0-9][A-Za-z0-9_\- .]*$'
                        minLength={1}
                        maxLength={64}
                        value={form.providerName}
                        onChange={(e) =>
                            onChange({ ...form, providerName: e.target.value })
                        }
                        placeholder={t('web.modelProviderFields.providerNamePlaceholder')}
                        className='workbench-input'
                    />
                </label>
            </div>
            <label className='block'>
                <span className='workbench-field-label'>{t('web.modelProviderFields.apiKey')}</span>
                <input
                    type='password'
                    autoComplete='off'
                    required={form.mode === 'create'}
                    placeholder={
                        form.mode === 'edit'
                            ? t('web.modelProviderFields.apiKeyKeepExisting')
                            : t('web.modelProviderFields.apiKeyPlaceholder')
                    }
                    value={form.apiKey}
                    onChange={(e) =>
                        onChange({ ...form, apiKey: e.target.value })
                    }
                    className='workbench-input font-mono'
                />
            </label>
            <label className='block'>
                <span className='workbench-field-label'>{t('web.modelProviderFields.baseUrl')}</span>
                <input
                    type='text'
                    required
                    value={form.baseUrl}
                    onChange={(e) =>
                        onChange({ ...form, baseUrl: e.target.value })
                    }
                    placeholder={t('web.modelProviderFields.baseUrlPlaceholder')}
                    className='workbench-input font-mono'
                />
            </label>
            <label className='block'>
                <span className='workbench-field-label'>
                    {t('web.modelProviderFields.modelsListUrl')}
                </span>
                <input
                    type='text'
                    value={form.modelsListUrl}
                    onChange={(e) =>
                        onChange({ ...form, modelsListUrl: e.target.value })
                    }
                    placeholder={defaultModelsListPlaceholder(form)}
                    className='workbench-input font-mono'
                />
                <span className='text-caption text-muted mt-1 block'>
                    {t('web.modelProviderFields.modelsListHint')}
                </span>
            </label>
            {onTest && (
                <div className='space-y-2'>
                    <div className='flex items-center gap-3'>
                        <button
                            type='button'
                            onClick={() => void runTest()}
                            disabled={!canTest || testing}
                            className='workbench-button-secondary h-9'
                        >
                            {testing ? t('web.modelProviderFields.testing') : t('web.modelProviderFields.testConnection')}
                        </button>
                        {!canTest && !testing && (
                            <span className='text-caption text-muted'>
                                {form.mode === 'edit'
                                    ? t('web.modelProviderFields.editTestHint')
                                    : t('web.modelProviderFields.createTestHint')}
                            </span>
                        )}
                    </div>
                    {testError && (
                        <div className='workbench-alert-error'>
                            <pre className='text-caption whitespace-pre-wrap font-mono'>
                                {testError}
                            </pre>
                        </div>
                    )}
                    {result && (
                        <ProviderTestResultBanner
                            status={result.status}
                            message={result.message ?? null}
                            models={result.models.map((m) => m.id)}
                            latencyMs={result.latencyMs}
                        />
                    )}
                </div>
            )}
        </>
    )
}

const defaultModelsListPlaceholder = (form: ModelProviderFormState): string => {
    const trimmed = form.baseUrl.trim()
    const base =
        trimmed.length > 0
            ? trimmed.replace(/\/+$/, '')
            : 'https://api.example.com/v1'
    if (form.inferenceProtocol === 'google_generate_content')
        return `Defaults to ${base}/v1beta/models?key=…`
    const path = /\/v\d+$/.test(base) ? '/models' : '/v1/models'
    return `Defaults to ${base}${path}`
}

export default ModelProviderFields
