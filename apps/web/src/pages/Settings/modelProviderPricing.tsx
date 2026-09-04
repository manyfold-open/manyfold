import type { FC, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import {
    ModelPriceCandidate,
    ModelPriceEntryView,
    ModelPriceSource,
    ModelPriceSourcesView,
    ProtocolModelMap,
    UserModelProviderSummary
} from '@manyfold/shared'
import { useI18n, type TFn } from '@/lib/i18n'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'

// Extracted from pages/Settings/ModelProviders.tsx so the page's core (BYO)
// and cloud (managed-aware) variants share one pricing panel.
export const flattenProtocolMap = (
    map: ProtocolModelMap | null | undefined
): string[] => {
    if (!map) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const list of Object.values(map)) {
        for (const id of list) {
            if (seen.has(id)) continue
            seen.add(id)
            out.push(id)
        }
    }
    return out
}

export type ModelPriceField =
    | 'inputCostPerToken'
    | 'outputCostPerToken'
    | 'cacheReadCostPerToken'
    | 'cacheCreationCostPerToken'

export const modelPriceFields: ModelPriceField[] = [
    'inputCostPerToken',
    'outputCostPerToken',
    'cacheReadCostPerToken',
    'cacheCreationCostPerToken'
]

export const modelPriceFieldLabel = (field: ModelPriceField, t: TFn): string =>
    t(
        field === 'inputCostPerToken'
            ? 'web.modelProviders.priceInput'
            : field === 'outputCostPerToken'
              ? 'web.modelProviders.priceOutput'
              : field === 'cacheReadCostPerToken'
                ? 'web.modelProviders.priceCacheRead'
                : 'web.modelProviders.priceCacheWrite'
    )

export const priceSourceName: Record<ModelPriceSource, string> = {
    litellm: 'LiteLLM',
    models_dev: 'models.dev',
    netmind: 'NetMind'
}

export const matchKindLabel = (
    kind: ModelPriceCandidate['matchKind'],
    t: TFn
): string => {
    const keys: Record<ModelPriceCandidate['matchKind'], Parameters<TFn>[0]> = {
        exact: 'web.modelProviders.matchExact',
        fuzzy: 'web.modelProviders.matchFuzzy',
        search: 'web.modelProviders.matchSearch'
    }
    return t(keys[kind])
}

// Vendors publish per-million rates, so the compact display uses them; the
// editable inputs stay per token to match what the API stores.
export const perMillionRate = (value: number | null): string =>
    value === null ? '—' : `$${Number((value * 1_000_000).toFixed(4))}`

// Whose number prices this model: the user's own row beats the platform's
// defaults, which beat the public tables.
export const priceScopeTag = (entry: ModelPriceEntryView, t: TFn): string =>
    entry.scope === 'provider'
        ? t('web.modelProviders.priceScopeCustom')
        : entry.scope === 'built_in' || entry.scope === 'global'
          ? t('web.modelProviders.priceScopePlatform')
          : entry.priceStatus === 'missing'
            ? t('web.modelProviders.priceScopeNoPrice')
            : priceSourceName[entry.priceStatus as ModelPriceSource]

export const priceDraftFor = (
    entry: ModelPriceEntryView | undefined
): Record<ModelPriceField, string> => ({
    inputCostPerToken:
        entry?.prices.inputCostPerToken === null ||
        entry?.prices.inputCostPerToken === undefined
            ? ''
            : String(entry.prices.inputCostPerToken),
    outputCostPerToken:
        entry?.prices.outputCostPerToken === null ||
        entry?.prices.outputCostPerToken === undefined
            ? ''
            : String(entry.prices.outputCostPerToken),
    cacheReadCostPerToken:
        entry?.prices.cacheReadCostPerToken === null ||
        entry?.prices.cacheReadCostPerToken === undefined
            ? ''
            : String(entry.prices.cacheReadCostPerToken),
    cacheCreationCostPerToken:
        entry?.prices.cacheCreationCostPerToken === null ||
        entry?.prices.cacheCreationCostPerToken === undefined
            ? ''
            : String(entry.prices.cacheCreationCostPerToken)
})

// The compact per-model price readout. Editable rows get a button that opens
// the editor panel; managed rows render the same content statically.
export const ModelPriceSummary: FC<{
    entry: ModelPriceEntryView | undefined
    expanded?: boolean
    onToggle?: () => void
    // The scope tag every row in this list shares. A tag that is identical on
    // all 62 rows tells a reader nothing they cannot read once in the panel
    // footer, so it is dropped where it matches and kept where it deviates —
    // `Custom`, `Platform` and `No price` are exactly the rows worth marking.
    commonScopeTag?: string
}> = ({ entry, expanded, onToggle, commonScopeTag }): ReactNode => {
    const { t } = useI18n()
    const scopeTag = entry ? priceScopeTag(entry, t) : '…'
    const body = (
        <>
            {scopeTag !== commonScopeTag && (
                <span className='tag tag-neutral'>{scopeTag}</span>
            )}
            {entry?.resolvedPrice && (
                <span className='text-caption text-muted tabular-nums'>
                    {perMillionRate(entry.resolvedPrice.inputCostPerToken)}{' '}
                    {t('web.modelProviders.priceInputShort')} ·{' '}
                    {perMillionRate(entry.resolvedPrice.outputCostPerToken)}{' '}
                    {t('web.modelProviders.priceOutputShort')} /1M
                </span>
            )}
        </>
    )
    // Static rows carry the source link on the price itself rather than beside
    // it: an arrow glyph repeated once per row is a second thing to skip past
    // on the way to the number.
    if (!onToggle)
        return entry?.priceRef ? (
            <a
                href={entry.priceRef.url}
                target='_blank'
                rel='noreferrer'
                onClick={(event) => event.stopPropagation()}
                className='hover:decoration-muted flex items-center gap-1.5 hover:underline hover:decoration-dotted'
            >
                {body}
            </a>
        ) : (
            <span className='flex items-center gap-1.5'>{body}</span>
        )
    return (
        <button
            type='button'
            onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onToggle()
            }}
            aria-expanded={expanded}
            className='hover:bg-soft/60 flex items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors'
        >
            {body}
        </button>
    )
}

// Per-model price editor for a BYO provider row: the ranked records from both
// public tables (pick one to pin), the four per-token inputs, and a reset back
// to automatic matching.
export const ModelPricePanel: FC<{
    providerId: string
    modelId: string
    entry: ModelPriceEntryView | undefined
    onSaved: (next: ModelPriceEntryView) => void
    onRemoved: () => void
}> = ({ providerId, modelId, entry, onSaved, onRemoved }): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const [draft, setDraft] = useState<Record<ModelPriceField, string>>(() =>
        priceDraftFor(entry)
    )
    const [candidates, setCandidates] = useState<ModelPriceSourcesView | null>(
        null
    )
    const [query, setQuery] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const loadCandidates = (q?: string): void => {
        client.modelProviders.modelPrices
            .candidates(providerId, modelId, q)
            .then(setCandidates)
            .catch((e: Error) => setError(apiErrorMessage(e)))
    }

    // Candidates load once per opened (provider, model); searches reload them
    // explicitly.
    useEffect(() => {
        client.modelProviders.modelPrices
            .candidates(providerId, modelId)
            .then(setCandidates)
            .catch((e: Error) => setError(apiErrorMessage(e)))
    }, [client, providerId, modelId])

    const put = async (body: {
        prices: Record<ModelPriceField, number | null>
        pin: { source: ModelPriceSource; key: string } | null
    }): Promise<void> => {
        setBusy(true)
        setError(null)
        try {
            const next = await client.modelProviders.modelPrices.upsert(
                providerId,
                {
                    modelId,
                    ...body.prices,
                    priceRefSource: body.pin?.source ?? null,
                    priceRefKey: body.pin?.key ?? null
                }
            )
            onSaved(next)
            setDraft(priceDraftFor(next))
            loadCandidates(query || undefined)
        } catch (e) {
            setError(apiErrorMessage(e))
        } finally {
            setBusy(false)
        }
    }

    const save = async (): Promise<void> => {
        const prices: Record<ModelPriceField, number | null> = {
            inputCostPerToken: null,
            outputCostPerToken: null,
            cacheReadCostPerToken: null,
            cacheCreationCostPerToken: null
        }
        for (const key of modelPriceFields) {
            const raw = draft[key].trim()
            if (raw.length === 0) continue
            const parsed = Number(raw)
            if (!Number.isFinite(parsed) || parsed < 0) {
                setError(`${modelPriceFieldLabel(key, t)} must be a number ≥ 0`)
                return
            }
            prices[key] = parsed
        }
        // Full-replace PUT: carry the row's existing pin or saving a price
        // would silently clear it.
        await put({ prices, pin: entry?.pin ?? null })
    }

    const pinCandidate = async (
        candidate: ModelPriceCandidate | null
    ): Promise<void> =>
        put({
            prices: {
                inputCostPerToken: entry?.prices.inputCostPerToken ?? null,
                outputCostPerToken: entry?.prices.outputCostPerToken ?? null,
                cacheReadCostPerToken:
                    entry?.prices.cacheReadCostPerToken ?? null,
                cacheCreationCostPerToken:
                    entry?.prices.cacheCreationCostPerToken ?? null
            },
            pin: candidate
                ? { source: candidate.source, key: candidate.key }
                : null
        })

    const remove = async (): Promise<void> => {
        setBusy(true)
        setError(null)
        try {
            await client.modelProviders.modelPrices.delete(providerId, modelId)
            onRemoved()
        } catch (e) {
            setError(apiErrorMessage(e))
        } finally {
            setBusy(false)
        }
    }

    const configured =
        entry !== undefined &&
        (entry.pin !== null ||
            Object.values(entry.prices).some((v) => v !== null))

    return (
        <div className='border-divider/70 bg-soft/30 border-t px-3 py-3'>
            {error && (
                <div className='workbench-alert-error mb-2'>
                    <pre className='text-caption whitespace-pre-wrap font-mono'>
                        {error}
                    </pre>
                </div>
            )}
            <div className='mb-2 flex flex-wrap items-end gap-2'>
                {modelPriceFields.map((field) => (
                    <label
                        key={field}
                        className='text-caption text-muted flex flex-col gap-1'
                    >
                        {modelPriceFieldLabel(field, t)}{' '}
                        {t('web.modelProviders.pricePerToken')}
                        <input
                            type='text'
                            inputMode='decimal'
                            value={draft[field]}
                            placeholder={
                                entry?.resolvedPrice
                                    ? String(entry.resolvedPrice[field] ?? '')
                                    : ''
                            }
                            onChange={(e) =>
                                setDraft((cur) => ({
                                    ...cur,
                                    [field]: e.target.value
                                }))
                            }
                            aria-label={t(
                                'web.modelProviders.priceCostPerTokenAria',
                                {
                                    model: modelId,
                                    label: modelPriceFieldLabel(field, t)
                                }
                            )}
                            className='workbench-input h-8 w-32 text-right tabular-nums'
                        />
                    </label>
                ))}
                <button
                    type='button'
                    onClick={() => void save()}
                    disabled={busy}
                    className='workbench-button-primary h-8'
                >
                    {busy
                        ? t('web.modelProviders.saving')
                        : t('web.modelProviders.savePrices')}
                </button>
                {configured && (
                    <button
                        type='button'
                        onClick={() => void remove()}
                        disabled={busy}
                        className='workbench-button-secondary h-8'
                    >
                        {t('web.modelProviders.resetAutomatic')}
                    </button>
                )}
            </div>

            <div className='mb-1.5 flex flex-wrap items-center gap-2'>
                <span className='text-caption text-muted'>
                    {t('web.modelProviders.pricingRecords')}
                </span>
                {(candidates?.sources ?? []).map((source) => (
                    <span key={source.source} className='tag tag-neutral'>
                        {priceSourceName[source.source]} · {source.entryCount}
                    </span>
                ))}
                <input
                    type='text'
                    value={query}
                    placeholder={t('web.modelProviders.searchPricing')}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter')
                            loadCandidates(query || undefined)
                    }}
                    aria-label={t('web.modelProviders.pricingSearchAria', {
                        model: modelId
                    })}
                    className='workbench-input h-8 w-56'
                />
                {entry?.pin && (
                    <button
                        type='button'
                        onClick={() => void pinCandidate(null)}
                        disabled={busy}
                        className='workbench-button-secondary h-8'
                    >
                        {t('web.modelProviders.useAutomatic')}
                    </button>
                )}
            </div>
            <div className='space-y-1'>
                {(candidates?.candidates ?? []).map((candidate) => {
                    const active =
                        entry?.priceRef?.source === candidate.source &&
                        entry?.priceRef?.key === candidate.key
                    return (
                        <div
                            key={`${candidate.source}:${candidate.key}`}
                            className='flex flex-wrap items-center gap-2'
                        >
                            <span className='tag tag-neutral'>
                                {priceSourceName[candidate.source]}
                            </span>
                            <a
                                href={candidate.url}
                                target='_blank'
                                rel='noreferrer'
                                className='text-caption text-link min-w-0 font-mono hover:underline'
                            >
                                {candidate.key} ↗
                            </a>
                            <span className='text-caption text-muted tabular-nums'>
                                {perMillionRate(
                                    candidate.prices.inputCostPerToken
                                )}{' '}
                                {t('web.modelProviders.priceInputShort')} ·{' '}
                                {perMillionRate(
                                    candidate.prices.outputCostPerToken
                                )}{' '}
                                {t('web.modelProviders.priceOutputShort')} /1M
                            </span>
                            <span className='tag tag-neutral'>
                                {matchKindLabel(candidate.matchKind, t)}
                            </span>
                            {active ? (
                                <span className='tag tag-neutral'>
                                    {t('web.modelProviders.priceInUse')}
                                </span>
                            ) : (
                                <button
                                    type='button'
                                    onClick={() => void pinCandidate(candidate)}
                                    disabled={busy}
                                    className='text-caption text-link hover:underline'
                                >
                                    {t('web.modelProviders.priceUseThis')}
                                </button>
                            )}
                        </div>
                    )
                })}
                {candidates && candidates.candidates.length === 0 && (
                    <p className='text-caption text-muted'>
                        {t('web.modelProviders.priceNoRecord')}
                    </p>
                )}
            </div>
        </div>
    )
}

export const totalModelCounts = (
    row: UserModelProviderSummary
): { total: number; enabled: number } => {
    let total = 0
    if (row.lastTestModels) {
        for (const list of Object.values(row.lastTestModels))
            total += list.length
    }
    if (total === 0) return { total: 0, enabled: 0 }
    if (row.enabledModels === null) return { total, enabled: total }
    let enabled = 0
    for (const list of Object.values(row.enabledModels)) enabled += list.length
    return { total, enabled }
}
