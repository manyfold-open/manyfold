import {
    ConfigurableFramework,
    FrameworkCatalogView,
    FrameworkEnumKey,
    FrameworkEnumView,
    FrameworkModelView,
    configurableFrameworks,
    frameworkEnumKeys
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { Badge, Button, Card, Heading, Input } from '@/ui'
import { cn } from '@/ui/classNames'

const frameworkLabel: Record<ConfigurableFramework, string> = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
    'gemini-cli': 'Gemini CLI'
}

const FrameworkCatalogPage: FC = (): ReactNode => {
    const client = useApiClient()
    const [framework, setFramework] = useState<ConfigurableFramework>(
        configurableFrameworks[0]
    )
    const [verCatBusy, setVerCatBusy] = useState(false)
    const [verCatMsg, setVerCatMsg] = useState<string | null>(null)

    const handleRefreshVersionCatalog = async (): Promise<void> => {
        setVerCatBusy(true)
        setVerCatMsg(null)
        try {
            const entries = await client.admin.frameworkVersions.refresh()
            const withVersions = entries.filter(
                (e) => e.versions.length > 0
            ).length
            setVerCatMsg(
                `Refreshed — ${withVersions}/${entries.length} frameworks have versions.`
            )
        } catch (err) {
            setVerCatMsg((err as Error).message)
        } finally {
            setVerCatBusy(false)
        }
    }

    return (
        <div className='mx-auto max-w-none'>
            <div className='mb-3'>
                <Heading level={2} className='mb-2'>
                    Framework Model Catalog
                </Heading>
                <p className='admin-page-description max-w-2xl'>
                    Manage the supported models, aliases, and enum values for
                    each coding-agent framework. Changes apply globally and
                    take effect within ~60 seconds (cache TTL).
                </p>
            </div>
            <Card elevation='flat' className='mb-4 p-3'>
                <div className='flex items-center justify-between gap-3'>
                    <div className='min-w-0'>
                        <p className='text-caption text-heading'>
                            Framework CLI version catalog
                        </p>
                        <p className='text-caption-sm text-body'>
                            Installable CLI versions (npm / GitHub) offered in
                            the per-agent upgrade picker. Auto-refreshes on boot
                            and every ~6h.
                        </p>
                    </div>
                    <Button
                        variant='neutral'
                        size='sm'
                        disabled={verCatBusy}
                        onClick={(): void => {
                            void handleRefreshVersionCatalog()
                        }}
                    >
                        {verCatBusy ? 'Refreshing…' : 'Refresh versions'}
                    </Button>
                </div>
                {verCatMsg ? (
                    <p className='text-caption-sm text-body mt-2'>{verCatMsg}</p>
                ) : null}
            </Card>
            <div className='mb-4 flex gap-2'>
                {configurableFrameworks.map((fw) => (
                    <button
                        key={fw}
                        type='button'
                        onClick={() => setFramework(fw)}
                        className={cn(
                            'rounded border px-3 py-1 text-caption transition-colors',
                            framework === fw
                                ? 'border-brand bg-brand-subtle text-brand'
                                : 'border-border text-body hover:bg-surface-muted'
                        )}
                    >
                        {frameworkLabel[fw]}
                    </button>
                ))}
            </div>
            <FrameworkPanel key={framework} framework={framework} />
        </div>
    )
}

interface FrameworkPanelProps {
    framework: ConfigurableFramework
}

const FrameworkPanel: FC<FrameworkPanelProps> = ({
    framework
}): ReactNode => {
    const client = useApiClient()
    const [view, setView] = useState<FrameworkCatalogView | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const refresh = useCallback((): void => {
        setError(null)
        client.admin.frameworkCatalog
            .get(framework)
            .then(setView)
            .catch((e: Error) => setError(e.message))
    }, [client, framework])

    useEffect(refresh, [refresh])

    return (
        <div className='space-y-5'>
            {error && (
                <Card
                    elevation='flat'
                    className='border-accent-ruby/30 bg-accent-ruby/5 p-2'
                >
                    <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                        {error}
                    </pre>
                </Card>
            )}

            {view === null && !error && (
                <p className='text-caption text-body'>Loading…</p>
            )}

            {view && (
                <>
                    <ModelsSection
                        framework={framework}
                        rows={view.models}
                        busy={busy}
                        setBusy={setBusy}
                        refresh={refresh}
                        setError={setError}
                    />
                    {frameworkEnumKeys.map((enumKey) => {
                        const rows = view.enums[enumKey]
                        if (!rows && !canEnumExist(framework, enumKey))
                            return null
                        return (
                            <EnumsSection
                                key={enumKey}
                                framework={framework}
                                enumKey={enumKey}
                                rows={rows ?? []}
                                busy={busy}
                                setBusy={setBusy}
                                refresh={refresh}
                                setError={setError}
                            />
                        )
                    })}
                </>
            )}
        </div>
    )
}

const canEnumExist = (
    framework: ConfigurableFramework,
    key: FrameworkEnumKey
): boolean => {
    if (framework === 'codex')
        return key === 'speed' || key === 'intelligence'
    if (framework === 'claude-code') return key === 'effort'
    return false
}

interface SectionCommonProps {
    framework: ConfigurableFramework
    busy: boolean
    setBusy: (b: boolean) => void
    refresh: () => void
    setError: (msg: string | null) => void
}

interface ModelsSectionProps extends SectionCommonProps {
    rows: FrameworkModelView[]
}

const ModelsSection: FC<ModelsSectionProps> = ({
    framework,
    rows,
    busy,
    setBusy,
    refresh,
    setError
}): ReactNode => {
    const client = useApiClient()
    const [adding, setAdding] = useState(false)
    const [draft, setDraft] = useState({
        modelKey: '',
        kind:
            framework === 'claude-code'
                ? ('alias' as const)
                : ('model' as const),
        displayName: '',
        capabilitiesFast: false,
        capabilitiesLongContext: false,
        sortOrder: 0,
        isDefault: false
    })

    const onCreate = async (): Promise<void> => {
        if (!draft.modelKey.trim() || !draft.displayName.trim()) return
        setBusy(true)
        try {
            await client.admin.frameworkCatalog.createModel(framework, {
                modelKey: draft.modelKey.trim(),
                kind: draft.kind,
                displayName: draft.displayName.trim(),
                capabilities: {
                    ...(draft.capabilitiesFast ? { fast: true } : {}),
                    ...(draft.capabilitiesLongContext
                        ? { longContext: true }
                        : {})
                },
                sortOrder: draft.sortOrder,
                isDefault: draft.isDefault
            })
            setAdding(false)
            setDraft({ ...draft, modelKey: '', displayName: '' })
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <Card elevation='flat' className='p-3'>
            <div className='mb-2 flex items-center justify-between'>
                <Heading level={3}>Models</Heading>
                <Button
                    variant='ghost'
                    onClick={() => setAdding((v) => !v)}
                    disabled={busy}
                >
                    {adding ? 'Cancel' : 'Add model'}
                </Button>
            </div>
            {adding && (
                <div className='mb-3 grid gap-2 rounded border border-border p-2 sm:grid-cols-3'>
                    <Input
                        id='new-model-key'
                        label='Model key'
                        value={draft.modelKey}
                        onChange={(e) =>
                            setDraft({ ...draft, modelKey: e.target.value })
                        }
                    />
                    <Input
                        id='new-display-name'
                        label='Display name'
                        value={draft.displayName}
                        onChange={(e) =>
                            setDraft({
                                ...draft,
                                displayName: e.target.value
                            })
                        }
                    />
                    <div className='space-y-1'>
                        <label
                            htmlFor='new-kind'
                            className='text-caption text-label block font-normal'
                        >
                            Kind
                        </label>
                        <select
                            id='new-kind'
                            value={draft.kind}
                            onChange={(e) =>
                                setDraft({
                                    ...draft,
                                    kind: e.target.value as 'model' | 'alias'
                                })
                            }
                            className='block h-8 rounded border border-border bg-white px-2 text-caption'
                        >
                            <option value='model'>model</option>
                            <option value='alias'>alias</option>
                        </select>
                    </div>
                    <Input
                        id='new-sort'
                        label='Sort order'
                        type='number'
                        value={String(draft.sortOrder)}
                        onChange={(e) =>
                            setDraft({
                                ...draft,
                                sortOrder: Number(e.target.value) || 0
                            })
                        }
                    />
                    <label className='text-caption text-body flex items-center gap-2'>
                        <input
                            type='checkbox'
                            checked={draft.capabilitiesFast}
                            onChange={(e) =>
                                setDraft({
                                    ...draft,
                                    capabilitiesFast: e.target.checked
                                })
                            }
                        />
                        Supports fast tier
                    </label>
                    <label className='text-caption text-body flex items-center gap-2'>
                        <input
                            type='checkbox'
                            checked={draft.capabilitiesLongContext}
                            onChange={(e) =>
                                setDraft({
                                    ...draft,
                                    capabilitiesLongContext: e.target.checked
                                })
                            }
                        />
                        Long context (1M)
                    </label>
                    <label className='text-caption text-body flex items-center gap-2'>
                        <input
                            type='checkbox'
                            checked={draft.isDefault}
                            onChange={(e) =>
                                setDraft({
                                    ...draft,
                                    isDefault: e.target.checked
                                })
                            }
                        />
                        Set as default
                    </label>
                    <div className='sm:col-span-3'>
                        <Button
                            variant='primary'
                            onClick={onCreate}
                            disabled={busy}
                        >
                            Create
                        </Button>
                    </div>
                </div>
            )}
            <div className='overflow-auto'>
                <table className='w-full text-caption'>
                    <thead>
                        <tr className='text-label border-b border-border'>
                            <th className='px-2 py-1.5 text-left'>Model key</th>
                            <th className='px-2 py-1.5 text-left'>Display</th>
                            <th className='px-2 py-1.5 text-left'>Kind</th>
                            <th className='px-2 py-1.5 text-left'>Caps</th>
                            <th className='px-2 py-1.5 text-left'>Sort</th>
                            <th className='px-2 py-1.5 text-left'>Status</th>
                            <th className='px-2 py-1.5 text-left'>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows
                            .slice()
                            .sort(
                                (a, b) =>
                                    a.sortOrder - b.sortOrder ||
                                    a.modelKey.localeCompare(b.modelKey)
                            )
                            .map((row) => (
                                <ModelRow
                                    key={row.id}
                                    framework={framework}
                                    row={row}
                                    busy={busy}
                                    setBusy={setBusy}
                                    refresh={refresh}
                                    setError={setError}
                                />
                            ))}
                    </tbody>
                </table>
            </div>
        </Card>
    )
}

interface ModelRowProps extends SectionCommonProps {
    row: FrameworkModelView
}

const ModelRow: FC<ModelRowProps> = ({
    framework,
    row,
    busy,
    setBusy,
    refresh,
    setError
}): ReactNode => {
    const client = useApiClient()
    const onToggleActive = async (): Promise<void> => {
        setBusy(true)
        try {
            await client.admin.frameworkCatalog.updateModel(
                framework,
                row.id,
                { isActive: !row.isActive }
            )
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }
    const onMakeDefault = async (): Promise<void> => {
        setBusy(true)
        try {
            await client.admin.frameworkCatalog.updateModel(
                framework,
                row.id,
                { isDefault: true }
            )
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }
    const onDelete = async (): Promise<void> => {
        if (!window.confirm(`Soft-delete ${row.modelKey}?`)) return
        setBusy(true)
        try {
            await client.admin.frameworkCatalog.deleteModel(framework, row.id)
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }
    const caps = [
        row.capabilities?.fast && 'fast',
        row.capabilities?.longContext && '1M'
    ].filter(Boolean)
    return (
        <tr className='border-b border-border last:border-0'>
            <td className='px-2 py-1.5 font-mono'>{row.modelKey}</td>
            <td className='px-2 py-1.5'>{row.displayName}</td>
            <td className='px-2 py-1.5'>{row.kind}</td>
            <td className='px-2 py-1.5'>{caps.join(', ') || '—'}</td>
            <td className='px-2 py-1.5'>{row.sortOrder}</td>
            <td className='px-2 py-1.5'>
                <div className='flex gap-1'>
                    <Badge tone={row.isActive ? 'success' : 'neutral'}>
                        {row.isActive ? 'active' : 'inactive'}
                    </Badge>
                    {row.isDefault && <Badge tone='brand'>default</Badge>}
                </div>
            </td>
            <td className='px-2 py-1.5'>
                <div className='flex gap-1'>
                    <Button
                        variant='ghost'
                        size='sm'
                        onClick={onToggleActive}
                        disabled={busy}
                    >
                        {row.isActive ? 'Deactivate' : 'Activate'}
                    </Button>
                    {!row.isDefault && row.isActive && (
                        <Button
                            variant='ghost'
                            size='sm'
                            onClick={onMakeDefault}
                            disabled={busy}
                        >
                            Make default
                        </Button>
                    )}
                    <Button
                        variant='ghost'
                        size='sm'
                        onClick={onDelete}
                        disabled={busy}
                    >
                        Delete
                    </Button>
                </div>
            </td>
        </tr>
    )
}

interface EnumsSectionProps extends SectionCommonProps {
    enumKey: FrameworkEnumKey
    rows: FrameworkEnumView[]
}

const EnumsSection: FC<EnumsSectionProps> = ({
    framework,
    enumKey,
    rows,
    busy,
    setBusy,
    refresh,
    setError
}): ReactNode => {
    const client = useApiClient()
    const [adding, setAdding] = useState(false)
    const [draft, setDraft] = useState({
        value: '',
        displayName: '',
        sortOrder: 0,
        isDefault: false
    })

    const onCreate = async (): Promise<void> => {
        if (!draft.value.trim() || !draft.displayName.trim()) return
        setBusy(true)
        try {
            await client.admin.frameworkCatalog.createEnum(framework, {
                enumKey,
                value: draft.value.trim(),
                displayName: draft.displayName.trim(),
                sortOrder: draft.sortOrder,
                isDefault: draft.isDefault
            })
            setAdding(false)
            setDraft({
                value: '',
                displayName: '',
                sortOrder: 0,
                isDefault: false
            })
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <Card elevation='flat' className='p-3'>
            <div className='mb-2 flex items-center justify-between'>
                <Heading level={3} className='capitalize'>
                    {enumKey}
                </Heading>
                <Button
                    variant='ghost'
                    onClick={() => setAdding((v) => !v)}
                    disabled={busy}
                >
                    {adding ? 'Cancel' : `Add ${enumKey} value`}
                </Button>
            </div>
            {adding && (
                <div className='mb-3 grid gap-2 rounded border border-border p-2 sm:grid-cols-3'>
                    <Input
                        id={`new-${enumKey}-value`}
                        label='Value'
                        value={draft.value}
                        onChange={(e) =>
                            setDraft({ ...draft, value: e.target.value })
                        }
                    />
                    <Input
                        id={`new-${enumKey}-display`}
                        label='Display name'
                        value={draft.displayName}
                        onChange={(e) =>
                            setDraft({
                                ...draft,
                                displayName: e.target.value
                            })
                        }
                    />
                    <Input
                        id={`new-${enumKey}-sort`}
                        label='Sort order'
                        type='number'
                        value={String(draft.sortOrder)}
                        onChange={(e) =>
                            setDraft({
                                ...draft,
                                sortOrder: Number(e.target.value) || 0
                            })
                        }
                    />
                    <label className='text-caption text-body flex items-center gap-2 sm:col-span-3'>
                        <input
                            type='checkbox'
                            checked={draft.isDefault}
                            onChange={(e) =>
                                setDraft({
                                    ...draft,
                                    isDefault: e.target.checked
                                })
                            }
                        />
                        Set as default
                    </label>
                    <div className='sm:col-span-3'>
                        <Button
                            variant='primary'
                            onClick={onCreate}
                            disabled={busy}
                        >
                            Create
                        </Button>
                    </div>
                </div>
            )}
            <div className='overflow-auto'>
                <table className='w-full text-caption'>
                    <thead>
                        <tr className='text-label border-b border-border'>
                            <th className='px-2 py-1.5 text-left'>Value</th>
                            <th className='px-2 py-1.5 text-left'>Display</th>
                            <th className='px-2 py-1.5 text-left'>Sort</th>
                            <th className='px-2 py-1.5 text-left'>Status</th>
                            <th className='px-2 py-1.5 text-left'>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows
                            .slice()
                            .sort(
                                (a, b) =>
                                    a.sortOrder - b.sortOrder ||
                                    a.value.localeCompare(b.value)
                            )
                            .map((row) => (
                                <EnumRow
                                    key={row.id}
                                    framework={framework}
                                    row={row}
                                    busy={busy}
                                    setBusy={setBusy}
                                    refresh={refresh}
                                    setError={setError}
                                />
                            ))}
                    </tbody>
                </table>
            </div>
        </Card>
    )
}

interface EnumRowProps extends SectionCommonProps {
    row: FrameworkEnumView
}

const EnumRow: FC<EnumRowProps> = ({
    framework,
    row,
    busy,
    setBusy,
    refresh,
    setError
}): ReactNode => {
    const client = useApiClient()
    const onToggleActive = async (): Promise<void> => {
        setBusy(true)
        try {
            await client.admin.frameworkCatalog.updateEnum(
                framework,
                row.id,
                { isActive: !row.isActive }
            )
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }
    const onMakeDefault = async (): Promise<void> => {
        setBusy(true)
        try {
            await client.admin.frameworkCatalog.updateEnum(
                framework,
                row.id,
                { isDefault: true }
            )
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }
    const onDelete = async (): Promise<void> => {
        if (!window.confirm(`Soft-delete ${row.value}?`)) return
        setBusy(true)
        try {
            await client.admin.frameworkCatalog.deleteEnum(framework, row.id)
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }
    return (
        <tr className='border-b border-border last:border-0'>
            <td className='px-2 py-1.5 font-mono'>{row.value}</td>
            <td className='px-2 py-1.5'>{row.displayName}</td>
            <td className='px-2 py-1.5'>{row.sortOrder}</td>
            <td className='px-2 py-1.5'>
                <div className='flex gap-1'>
                    <Badge tone={row.isActive ? 'success' : 'neutral'}>
                        {row.isActive ? 'active' : 'inactive'}
                    </Badge>
                    {row.isDefault && <Badge tone='brand'>default</Badge>}
                </div>
            </td>
            <td className='px-2 py-1.5'>
                <div className='flex gap-1'>
                    <Button
                        variant='ghost'
                        size='sm'
                        onClick={onToggleActive}
                        disabled={busy}
                    >
                        {row.isActive ? 'Deactivate' : 'Activate'}
                    </Button>
                    {!row.isDefault && row.isActive && (
                        <Button
                            variant='ghost'
                            size='sm'
                            onClick={onMakeDefault}
                            disabled={busy}
                        >
                            Make default
                        </Button>
                    )}
                    <Button
                        variant='ghost'
                        size='sm'
                        onClick={onDelete}
                        disabled={busy}
                    >
                        Delete
                    </Button>
                </div>
            </td>
        </tr>
    )
}

export default FrameworkCatalogPage
