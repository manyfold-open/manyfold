import type {
    ExternalAgentProviderKind,
    UserExternalAgentProviderSummary
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { CheckIcon, ChevronDownIcon } from '@/components/icons'
import { Ghost } from '@/components/Loading'
import { useLoadingGate } from '@/components/useLoadingGate'
import SettingsPageHeader from '@/components/SettingsPageHeader'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import ProductDialog from '@/components/ProductDialog'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { FrameworkLogo } from '@/lib/frameworkMeta'
import { useI18n, type TFn } from '@/lib/i18n'

const ProviderLogo: FC<{
    kind: ExternalAgentProviderKind
    size?: 'sm' | 'md'
}> = ({ kind, size = 'sm' }): ReactNode => {
    const px = size === 'md' ? 22 : 16
    return <FrameworkLogo framework={kind} size={px} className='shrink-0' />
}

type FilterValue = ExternalAgentProviderKind | 'all'

interface FormState {
    provider: ExternalAgentProviderKind
    label: string
    endpointUrl: string
    apiKey: string
}

const initialForm: FormState = {
    provider: 'dify',
    label: '',
    endpointUrl: '',
    apiKey: ''
}

const providerLabel = (kind: ExternalAgentProviderKind): string =>
    kind === 'a2a' ? 'A2A' : kind === 'langflow' ? 'Langflow' : 'Dify'

const filterLabel = (value: FilterValue, t: TFn): string =>
    value === 'all'
        ? t('web.externalAgentProviders.allProviders')
        : providerLabel(value)

const defaultEndpointFor = (kind: ExternalAgentProviderKind): string =>
    kind === 'dify' ? 'https://api.dify.ai/v1' : ''

const endpointPlaceholderFor = (kind: ExternalAgentProviderKind): string =>
    kind === 'langflow'
        ? 'http://your-langflow.example'
        : kind === 'a2a'
          ? 'https://agent.example/.well-known/agent-card.json'
          : 'https://api.dify.ai/v1'

const FILTER_OPTIONS: FilterValue[] = ['all', 'dify', 'langflow', 'a2a']

const ExternalAgentProviders: FC = (): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const { confirm, confirmDialog } = useProductConfirm()
    const [rows, setRows] = useState<UserExternalAgentProviderSummary[]>([])
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [showForm, setShowForm] = useState(false)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [form, setForm] = useState<FormState>(initialForm)
    const [testResult, setTestResult] = useState<{
        ok: boolean
        message: string
    } | null>(null)
    const [testingId, setTestingId] = useState<string | null>(null)
    const [filterProvider, setFilterProvider] = useState<FilterValue>('all')
    const [filterOpen, setFilterOpen] = useState(false)
    const filterRef = useRef<HTMLDivElement | null>(null)

    const isEditing = editingId !== null

    // §10.8: never show "No providers yet" while the first list is in
    // flight — a first-use empty state must be a fact, not a guess.
    const [loading, setLoading] = useState(true)
    const gate = useLoadingGate(loading)

    const refresh = async (): Promise<void> => {
        try {
            const items = await client.externalAgentProviders.list()
            setRows(items)
            setError(null)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        void refresh()
    }, [client])

    useEffect(() => {
        if (!filterOpen) return
        const onPointerDown = (event: PointerEvent): void => {
            if (!filterRef.current?.contains(event.target as Node)) {
                setFilterOpen(false)
            }
        }
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setFilterOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [filterOpen])

    const onProviderChange = (provider: ExternalAgentProviderKind): void => {
        setForm({
            ...form,
            provider,
            endpointUrl: form.endpointUrl || defaultEndpointFor(provider)
        })
        setTestResult(null)
    }

    const startCreate = (): void => {
        setEditingId(null)
        const provider: ExternalAgentProviderKind =
            filterProvider === 'all' ? 'dify' : filterProvider
        setForm({ ...initialForm, provider })
        setTestResult(null)
        setShowForm(true)
    }

    const startEdit = (row: UserExternalAgentProviderSummary): void => {
        setEditingId(row.id)
        setForm({
            provider: row.provider,
            label: row.label,
            endpointUrl: row.endpointUrl,
            apiKey: ''
        })
        setTestResult(null)
        setShowForm(true)
    }

    const closeForm = (): void => {
        setShowForm(false)
        setEditingId(null)
        setForm(initialForm)
        setTestResult(null)
    }

    const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
            if (isEditing && editingId) {
                const patch: {
                    label?: string
                    endpointUrl?: string
                    apiKey?: string
                } = {
                    label: form.label.trim(),
                    endpointUrl: form.endpointUrl.trim()
                }
                if (form.apiKey.length > 0) patch.apiKey = form.apiKey
                await client.externalAgentProviders.update(editingId, patch)
            } else {
                await client.externalAgentProviders.create({
                    provider: form.provider,
                    label: form.label.trim(),
                    endpointUrl: form.endpointUrl.trim(),
                    apiKey: form.apiKey
                })
            }
            closeForm()
            await refresh()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const onTestInline = async (): Promise<void> => {
        if (!form.endpointUrl.trim() || !form.apiKey) return
        setTestResult(null)
        try {
            const result = await client.externalAgentProviders.testInline({
                provider: form.provider,
                endpointUrl: form.endpointUrl.trim(),
                apiKey: form.apiKey
            })
            setTestResult({ ok: result.ok, message: result.message })
        } catch (err) {
            setTestResult({ ok: false, message: (err as Error).message })
        }
    }

    const onTestSaved = async (id: string): Promise<void> => {
        setTestingId(id)
        try {
            await client.externalAgentProviders.test(id)
            await refresh()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setTestingId(null)
        }
    }

    const onDelete = async (id: string): Promise<void> => {
        if (
            !(await confirm({
                title: t('web.externalAgentProviders.deleteTitle'),
                description: t('web.externalAgentProviders.deleteDescription'),
                confirmLabel: t('web.externalAgentProviders.delete'),
                tone: 'danger'
            }))
        ) {
            return
        }
        try {
            await client.externalAgentProviders.delete(id)
            if (editingId === id) closeForm()
            await refresh()
        } catch (err) {
            setError(apiErrorMessage(err))
        }
    }

    const submitDisabled =
        busy || !form.label || !form.endpointUrl || (!isEditing && !form.apiKey)

    const filteredRows =
        filterProvider === 'all'
            ? rows
            : rows.filter((row) => row.provider === filterProvider)

    const counts: Record<FilterValue, number> = {
        all: rows.length,
        dify: rows.filter((r) => r.provider === 'dify').length,
        langflow: rows.filter((r) => r.provider === 'langflow').length,
        a2a: rows.filter((r) => r.provider === 'a2a').length
    }

    return (
        <div className='settings-page space-y-4'>
            <SettingsPageHeader
                breadcrumb={[
                    {
                        label: t('web.settingsLayout.runtimes'),
                        to: '/settings/runtimes'
                    },
                    { label: t('web.externalAgentProviders.title') }
                ]}
                title={t('web.externalAgentProviders.title')}
                description={t('web.externalAgentProviders.description')}
                actions={
                    <button
                        type='button'
                        className='workbench-button-primary h-9'
                        onClick={startCreate}
                    >
                        {t('web.externalAgentProviders.add')}
                    </button>
                }
            />

            {error && (
                <div className='border-accent-ruby/30 bg-accent-ruby/5 text-accent-ruby text-caption rounded border px-3 py-2'>
                    {error}
                </div>
            )}

            <div ref={filterRef} className='relative inline-block'>
                <ShortcutTooltip
                    label={t('web.externalAgentProviders.filterTooltip')}
                    placement='bottom-start'
                >
                    <button
                        type='button'
                        aria-haspopup='listbox'
                        aria-expanded={filterOpen}
                        onClick={() => setFilterOpen((prev) => !prev)}
                        className='text-ui text-fg shadow-ring-light bg-surface hover:bg-surface-hover focus-visible:shadow-focus flex h-10 w-auto min-w-[14rem] items-center justify-between gap-2 rounded-sm px-3.5 transition-[color,background-color,box-shadow] focus:outline-none'
                    >
                        <span className='flex min-w-0 items-center gap-2'>
                            {filterProvider !== 'all' && (
                                <ProviderLogo kind={filterProvider} />
                            )}
                            <span className='truncate'>
                                {filterLabel(filterProvider, t)}
                            </span>
                            <span className='text-caption text-muted'>
                                ({counts[filterProvider]})
                            </span>
                        </span>
                        <ChevronDownIcon className='text-subtle h-4 w-4 shrink-0' />
                    </button>
                </ShortcutTooltip>
                {filterOpen && (
                    <div
                        role='listbox'
                        aria-label={t('web.externalAgentProviders.filterAria')}
                        className='popover-panel shadow-elevated bg-surface-elevated/95 absolute left-0 top-full z-20 mt-1.5 min-w-full overflow-auto rounded-md p-1 backdrop-blur'
                    >
                        {FILTER_OPTIONS.map((option) => {
                            const active = filterProvider === option
                            return (
                                <button
                                    key={option}
                                    type='button'
                                    role='option'
                                    aria-selected={active}
                                    onClick={() => {
                                        setFilterProvider(option)
                                        setFilterOpen(false)
                                    }}
                                    className={[
                                        'text-ui hover:bg-soft hover:text-fg flex w-full items-center justify-between gap-2.5 rounded-sm px-2.5 py-1.5 text-left transition-colors',
                                        active
                                            ? 'text-fg font-medium'
                                            : 'text-muted'
                                    ].join(' ')}
                                >
                                    <span className='flex min-w-0 items-center gap-2'>
                                        {option !== 'all' && (
                                            <ProviderLogo kind={option} />
                                        )}
                                        <span className='truncate'>
                                            {filterLabel(option, t)}
                                        </span>
                                    </span>
                                    <span className='flex shrink-0 items-center gap-2'>
                                        <span className='text-caption text-muted'>
                                            {counts[option]}
                                        </span>
                                        {active && (
                                            <CheckIcon className='text-link h-3.5 w-3.5' />
                                        )}
                                    </span>
                                </button>
                            )
                        })}
                    </div>
                )}
            </div>

            <div
                className='border-border rounded border bg-white'
                aria-busy={gate.showLoading}
            >
                {gate.showLoading ? (
                    <ul className='divide-border divide-y'>
                        {[0, 1, 2].map((row) => (
                            <li
                                key={row}
                                className='flex items-center gap-3 p-4'
                            >
                                <Ghost
                                    variant='tile'
                                    className='h-8 w-8 shrink-0'
                                />
                                <div className='min-w-0 flex-1'>
                                    <Ghost
                                        variant='line'
                                        className='w-40 max-w-full'
                                    />
                                    <Ghost
                                        variant='cap'
                                        className='mt-2.5 w-3/5'
                                    />
                                </div>
                                <Ghost
                                    variant='block'
                                    className='h-9 w-20 shrink-0'
                                />
                            </li>
                        ))}
                    </ul>
                ) : loading ? null : filteredRows.length === 0 ? (
                    <p className='text-caption text-body p-4'>
                        {rows.length === 0
                            ? t('web.externalAgentProviders.empty')
                            : t('web.externalAgentProviders.emptyFiltered', {
                                  provider: filterLabel(
                                      filterProvider,
                                      t
                                  ).toLowerCase()
                              })}
                    </p>
                ) : (
                    <ul className='divide-border divide-y'>
                        {filteredRows.map((p) => (
                            <li
                                key={p.id}
                                className={`flex flex-col gap-1 p-4 sm:flex-row sm:items-center sm:justify-between ${
                                    editingId === p.id ? 'bg-brand-subtle' : ''
                                }`}
                            >
                                <div className='flex min-w-0 items-start gap-3'>
                                    <ProviderLogo kind={p.provider} size='md' />
                                    <div className='min-w-0'>
                                        <div className='text-ui font-medium'>
                                            {p.label}{' '}
                                            <span className='text-caption text-body font-normal'>
                                                ({providerLabel(p.provider)})
                                            </span>
                                        </div>
                                        <div className='text-caption text-body truncate font-mono'>
                                            {p.endpointUrl} ·{' '}
                                            {t(
                                                'web.externalAgentProviders.keyLabel'
                                            )}{' '}
                                            {p.apiKeyMasked}
                                        </div>
                                        {p.lastTestedAt && (
                                            <div className='text-caption text-body mt-1'>
                                                {t(
                                                    'web.externalAgentProviders.lastTest'
                                                )}{' '}
                                                {p.lastTestStatus === 'ok'
                                                    ? '✓ '
                                                    : '✗ '}
                                                {p.lastTestMessage ?? ''} ·{' '}
                                                {p.lastTestedAt}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className='flex items-center gap-2'>
                                    <button
                                        type='button'
                                        className='btn-secondary'
                                        onClick={() => startEdit(p)}
                                        disabled={editingId === p.id}
                                    >
                                        {editingId === p.id
                                            ? t(
                                                  'web.externalAgentProviders.editing'
                                              )
                                            : t(
                                                  'web.externalAgentProviders.edit'
                                              )}
                                    </button>
                                    <button
                                        type='button'
                                        className='btn-secondary'
                                        onClick={() => onTestSaved(p.id)}
                                        disabled={testingId === p.id}
                                    >
                                        {testingId === p.id
                                            ? t(
                                                  'web.externalAgentProviders.testing'
                                              )
                                            : t(
                                                  'web.externalAgentProviders.test'
                                              )}
                                    </button>
                                    <button
                                        type='button'
                                        className='btn-danger'
                                        onClick={() => onDelete(p.id)}
                                    >
                                        {t('web.externalAgentProviders.delete')}
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {showForm && (
                <ProductDialog
                    title={
                        isEditing
                            ? t('web.externalAgentProviders.editTitle')
                            : t('web.externalAgentProviders.add')
                    }
                    description={
                        isEditing
                            ? t('web.externalAgentProviders.editDescription')
                            : t('web.externalAgentProviders.addDescription')
                    }
                    onClose={closeForm}
                    onSubmit={onSubmit}
                    closeDisabled={busy}
                    bodyClassName='space-y-4'
                    footerClassName='justify-between'
                    footer={
                        <>
                            <ShortcutTooltip
                                label={
                                    isEditing && !form.apiKey
                                        ? t(
                                              'web.externalAgentProviders.testHint'
                                          )
                                        : undefined
                                }
                                placement='top'
                            >
                                <button
                                    type='button'
                                    className='workbench-button-secondary'
                                    onClick={onTestInline}
                                    disabled={!form.endpointUrl || !form.apiKey}
                                >
                                    {t(
                                        'web.externalAgentProviders.testConnection'
                                    )}
                                </button>
                            </ShortcutTooltip>
                            <div className='flex items-center gap-2'>
                                <button
                                    type='button'
                                    className='workbench-button-secondary'
                                    onClick={closeForm}
                                    disabled={busy}
                                >
                                    {t('web.agentNew.cancel')}
                                </button>
                                <button
                                    type='submit'
                                    className='workbench-button-primary'
                                    disabled={submitDisabled}
                                >
                                    {busy
                                        ? t('common.saving')
                                        : isEditing
                                          ? t(
                                                'web.externalAgentProviders.saveChanges'
                                            )
                                          : t('common.save')}
                                </button>
                            </div>
                        </>
                    }
                >
                    <div>
                        <label className='text-caption text-label mb-1 block font-normal'>
                            {t('web.credentials.provider')}
                        </label>
                        <div className='grid grid-cols-2 gap-3'>
                            {(['dify', 'langflow', 'a2a'] as const).map((p) => (
                                <label
                                    key={p}
                                    className={`flex items-center gap-2 rounded border px-3 py-2 ${
                                        form.provider === p
                                            ? 'border-brand bg-brand-subtle'
                                            : 'border-border bg-white'
                                    } ${isEditing ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                                >
                                    <input
                                        type='radio'
                                        name='provider'
                                        value={p}
                                        checked={form.provider === p}
                                        disabled={isEditing}
                                        onChange={() => onProviderChange(p)}
                                    />
                                    <ProviderLogo kind={p} />
                                    {providerLabel(p)}
                                </label>
                            ))}
                        </div>
                        {isEditing && (
                            <p className='text-caption text-body mt-1'>
                                {t('web.externalAgentProviders.providerFixed')}
                            </p>
                        )}
                    </div>

                    <div>
                        <label className='text-caption text-label mb-1 block font-normal'>
                            {t('web.externalAgentProviders.label')}
                        </label>
                        <input
                            type='text'
                            value={form.label}
                            onChange={(e) =>
                                setForm({ ...form, label: e.target.value })
                            }
                            placeholder={t(
                                'web.externalAgentProviders.labelPlaceholder'
                            )}
                            required
                            autoFocus
                            className='border-border block h-10 w-full rounded border bg-white px-3'
                        />
                    </div>

                    <div>
                        <label className='text-caption text-label mb-1 block font-normal'>
                            {t('web.externalAgentProviders.endpoint')}
                        </label>
                        <input
                            type='url'
                            value={form.endpointUrl}
                            onChange={(e) =>
                                setForm({
                                    ...form,
                                    endpointUrl: e.target.value
                                })
                            }
                            placeholder={endpointPlaceholderFor(form.provider)}
                            required
                            className='border-border block h-10 w-full rounded border bg-white px-3 font-mono'
                        />
                    </div>

                    <div>
                        <label className='text-caption text-label mb-1 block font-normal'>
                            {t('web.externalAgentProviders.apiKey')}
                        </label>
                        <input
                            type='password'
                            value={form.apiKey}
                            onChange={(e) =>
                                setForm({
                                    ...form,
                                    apiKey: e.target.value
                                })
                            }
                            required={!isEditing}
                            placeholder={
                                isEditing
                                    ? t(
                                          'web.externalAgentProviders.apiKeyKeepExisting'
                                      )
                                    : ''
                            }
                            className='border-border block h-10 w-full rounded border bg-white px-3 font-mono'
                        />
                    </div>

                    {testResult && (
                        <div
                            className={`text-caption rounded border px-3 py-2 ${
                                testResult.ok
                                    ? 'border-accent-emerald/30 bg-accent-emerald/5 text-accent-emerald'
                                    : 'border-accent-ruby/30 bg-accent-ruby/5 text-accent-ruby'
                            }`}
                        >
                            {testResult.ok ? '✓ ' : '✗ '}
                            {testResult.message}
                        </div>
                    )}
                </ProductDialog>
            )}
            {confirmDialog}
        </div>
    )
}

export default ExternalAgentProviders
