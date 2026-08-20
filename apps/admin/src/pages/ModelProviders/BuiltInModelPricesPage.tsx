import type {
    BuiltInModelPriceEntryView,
    BuiltInModelPricesProviderView,
    ModelPriceCandidate,
    ModelPriceSourceStatusView,
    ModelPriceSourcesView,
    UpsertBuiltInModelPriceBody
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { Badge, Button, Card, Heading } from '@/ui'
import {
    draftForPrices,
    formatTime,
    parsePriceDraft,
    PriceCandidatesPanel,
    priceFields,
    PriceSourceCell,
    sourceLabel,
    type PriceField
} from './priceCells'

const entryKey = (builtInId: string, modelId: string): string =>
    `${builtInId}:${modelId}`

const BuiltInModelPricesPage: FC = (): ReactNode => {
    const client = useApiClient()
    const [providers, setProviders] = useState<
        BuiltInModelPricesProviderView[] | null
    >(null)
    const [sourceStatuses, setSourceStatuses] = useState<
        ModelPriceSourceStatusView[]
    >([])
    const [error, setError] = useState<string | null>(null)
    const [status, setStatus] = useState<string | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [drafts, setDrafts] = useState<
        Record<string, Record<PriceField, string>>
    >({})
    const [openKey, setOpenKey] = useState<string | null>(null)
    const [sources, setSources] = useState<ModelPriceSourcesView | null>(null)
    const [sourceQuery, setSourceQuery] = useState('')
    const [unpricedOnly, setUnpricedOnly] = useState(false)
    const [nameFilter, setNameFilter] = useState('')
    const [addDrafts, setAddDrafts] = useState<Record<string, string>>({})

    const load = useCallback((): void => {
        setError(null)
        client.admin.builtInModelPrices
            .list()
            .then((view) => {
                setProviders(view.providers)
                setSourceStatuses(view.sources)
            })
            .catch((err: Error) => setError(err.message))
    }, [client])

    useEffect(load, [load])

    const unpricedTotal = useMemo(
        () =>
            (providers ?? []).reduce(
                (sum, provider) => sum + provider.unpricedCount,
                0
            ),
        [providers]
    )

    const applyEntry = (
        builtInId: string,
        next: BuiltInModelPriceEntryView
    ): void => {
        setProviders(
            (current) =>
                current?.map((provider) => {
                    if (provider.builtInId !== builtInId) return provider
                    const exists = provider.models.some(
                        (m) => m.modelId === next.modelId
                    )
                    const models = exists
                        ? provider.models.map((m) =>
                              m.modelId === next.modelId ? next : m
                          )
                        : [...provider.models, next].sort((a, b) =>
                              a.modelId.localeCompare(b.modelId)
                          )
                    return {
                        ...provider,
                        models,
                        unpricedCount: models.filter(
                            (m) => m.priceStatus === 'missing'
                        ).length
                    }
                }) ?? current
        )
        setDrafts((current) => {
            const { [entryKey(builtInId, next.modelId)]: _dropped, ...rest } =
                current
            return rest
        })
    }

    const upsert = async (
        builtInId: string,
        modelId: string,
        body: Omit<UpsertBuiltInModelPriceBody, 'builtInId' | 'modelId'>,
        busyKey: string,
        message: string
    ): Promise<BuiltInModelPriceEntryView | null> => {
        setBusy(busyKey)
        setError(null)
        setStatus(null)
        try {
            const next = await client.admin.builtInModelPrices.upsert({
                builtInId,
                modelId,
                ...body
            })
            applyEntry(builtInId, next)
            setStatus(message)
            return next
        } catch (err) {
            setError((err as Error).message)
            return null
        } finally {
            setBusy(null)
        }
    }

    const savePrices = async (
        provider: BuiltInModelPricesProviderView,
        entry: BuiltInModelPriceEntryView
    ): Promise<void> => {
        const key = entryKey(provider.builtInId, entry.modelId)
        const draft = drafts[key]
        if (!draft) return
        const body = parsePriceDraft(draft)
        if (typeof body === 'string') {
            setError(`${entry.modelId}: ${body}`)
            return
        }
        // PUT is full-replace: carry the row's own pin or saving a price would
        // silently clear it.
        await upsert(
            provider.builtInId,
            entry.modelId,
            {
                ...body,
                priceRefSource: entry.pin?.source ?? null,
                priceRefKey: entry.pin?.key ?? null
            },
            `prices:${key}`,
            `${entry.modelId} pricing saved`
        )
    }

    const pinSource = async (
        provider: BuiltInModelPricesProviderView,
        entry: BuiltInModelPriceEntryView,
        candidate: ModelPriceCandidate | null
    ): Promise<void> => {
        const key = entryKey(provider.builtInId, entry.modelId)
        const next = await upsert(
            provider.builtInId,
            entry.modelId,
            {
                inputCostPerToken: entry.prices.inputCostPerToken,
                outputCostPerToken: entry.prices.outputCostPerToken,
                cacheReadCostPerToken: entry.prices.cacheReadCostPerToken,
                cacheCreationCostPerToken:
                    entry.prices.cacheCreationCostPerToken,
                priceRefSource: candidate?.source ?? null,
                priceRefKey: candidate?.key ?? null
            },
            `pin:${key}`,
            candidate
                ? `${entry.modelId} now priced from ${sourceLabel[candidate.source]} ${candidate.key}`
                : `${entry.modelId} back to automatic matching`
        )
        if (next)
            loadSources(
                provider.builtInId,
                entry.modelId,
                sourceQuery || undefined
            )
    }

    const removeEntry = async (
        provider: BuiltInModelPricesProviderView,
        entry: BuiltInModelPriceEntryView
    ): Promise<void> => {
        const key = entryKey(provider.builtInId, entry.modelId)
        setBusy(`remove:${key}`)
        setError(null)
        setStatus(null)
        try {
            await client.admin.builtInModelPrices.delete(
                provider.builtInId,
                entry.modelId
            )
            setStatus(`${entry.modelId} price configuration removed`)
            setOpenKey((current) => (current === key ? null : current))
            // An observed model stays listed (back to automatic matching); a
            // manual add disappears — reload rather than re-deriving that here.
            load()
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(null)
        }
    }

    const addModel = async (
        provider: BuiltInModelPricesProviderView
    ): Promise<void> => {
        const modelId = (addDrafts[provider.builtInId] ?? '').trim()
        if (!modelId) return
        const next = await upsert(
            provider.builtInId,
            modelId,
            {},
            `add:${provider.builtInId}`,
            `${modelId} added to ${provider.label}`
        )
        if (next)
            setAddDrafts((current) => ({
                ...current,
                [provider.builtInId]: ''
            }))
    }

    const editPrice = (
        key: string,
        entry: BuiltInModelPriceEntryView,
        field: PriceField,
        value: string
    ): void => {
        setDrafts((current) => ({
            ...current,
            [key]: {
                ...(current[key] ?? draftForPrices(entry.prices)),
                [field]: value
            }
        }))
    }

    const loadSources = useCallback(
        (builtInId: string, modelId: string, query?: string): void => {
            setBusy(`sources:${entryKey(builtInId, modelId)}`)
            setError(null)
            client.admin.builtInModelPrices
                .candidates(builtInId, modelId, query)
                .then(setSources)
                .catch((err: Error) => setError(err.message))
                .finally(() => setBusy(null))
        },
        [client]
    )

    const toggleSources = (
        provider: BuiltInModelPricesProviderView,
        entry: BuiltInModelPriceEntryView
    ): void => {
        const key = entryKey(provider.builtInId, entry.modelId)
        if (openKey === key) {
            setOpenKey(null)
            setSources(null)
            return
        }
        setOpenKey(key)
        setSources(null)
        setSourceQuery('')
        loadSources(provider.builtInId, entry.modelId)
    }

    return (
        <div>
            <div className='mb-3 flex flex-wrap items-start justify-between gap-2'>
                <div className='max-w-3xl'>
                    <Heading level={2} className='mb-2'>
                        Built-in provider prices
                    </Heading>
                    <p className='admin-page-description'>
                        Platform-wide default prices for the models served by
                        the built-in providers users bring their own keys to.
                        The list is what users' keys have actually reported,
                        never probed from here — plus anything added by hand.
                        Prices resolve from LiteLLM first, then models.dev;
                        click a price to see the matched record and pin a
                        different one. A user's own per-model price on their
                        provider row overrides these defaults for that row
                        only.
                    </p>
                </div>
                <div className='flex flex-wrap items-center gap-2'>
                    {sourceStatuses.map((source) => (
                        <Badge key={source.source} tone='neutral'>
                            {sourceLabel[source.source]} · {source.entryCount}{' '}
                            models · {formatTime(source.fetchedAt)}
                        </Badge>
                    ))}
                </div>
            </div>

            {error && (
                <Card
                    elevation='flat'
                    className='border-accent-ruby/30 bg-accent-ruby/5 mb-2 p-2'
                >
                    <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                        {error}
                    </pre>
                </Card>
            )}

            {status && (
                <p className='text-caption-sm text-brand mb-2'>{status}</p>
            )}

            {providers && (
                <div className='mb-2 flex flex-wrap items-center gap-3'>
                    <input
                        type='text'
                        value={nameFilter}
                        placeholder='filter models…'
                        onChange={(e) => setNameFilter(e.target.value)}
                        aria-label='filter models by id'
                        className='border-border text-caption text-heading focus:border-brand focus:ring-brand h-7 w-56 rounded border bg-white px-1.5 transition-colors focus:ring-1 focus:outline-none'
                    />
                    <label className='text-caption-sm text-body flex items-center gap-1.5'>
                        <input
                            type='checkbox'
                            className='accent-brand'
                            checked={unpricedOnly}
                            onChange={(e) => setUnpricedOnly(e.target.checked)}
                        />
                        Only unpriced
                        {unpricedTotal > 0 && (
                            <Badge tone='error'>{unpricedTotal}</Badge>
                        )}
                    </label>
                </div>
            )}

            {!providers && !error && (
                <p className='text-caption text-body'>Loading…</p>
            )}

            <div className='space-y-4'>
                {(providers ?? []).map((provider) => {
                    const filter = nameFilter.trim().toLowerCase()
                    const models = provider.models.filter(
                        (entry) =>
                            (!unpricedOnly ||
                                entry.priceStatus === 'missing') &&
                            (!filter ||
                                entry.modelId.toLowerCase().includes(filter))
                    )
                    return (
                        <Card
                            key={provider.builtInId}
                            elevation='ambient'
                            className='overflow-hidden'
                        >
                            <div className='border-border flex flex-wrap items-center justify-between gap-2 border-b px-2 py-1.5'>
                                <div className='flex flex-wrap items-center gap-2'>
                                    <Heading level={4}>
                                        {provider.label}
                                    </Heading>
                                    <Badge tone='neutral'>
                                        {provider.providerRowCount} user key
                                        {provider.providerRowCount === 1
                                            ? ''
                                            : 's'}
                                    </Badge>
                                    {provider.unpricedCount > 0 && (
                                        <Badge tone='error'>
                                            {provider.unpricedCount} unpriced
                                        </Badge>
                                    )}
                                </div>
                                <div className='flex items-center gap-1.5'>
                                    <input
                                        type='text'
                                        value={
                                            addDrafts[provider.builtInId] ?? ''
                                        }
                                        placeholder='model id…'
                                        onChange={(e) =>
                                            setAddDrafts((current) => ({
                                                ...current,
                                                [provider.builtInId]:
                                                    e.target.value
                                            }))
                                        }
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter')
                                                void addModel(provider)
                                        }}
                                        aria-label={`add a model to ${provider.label}`}
                                        className='border-border text-caption text-heading focus:border-brand focus:ring-brand h-7 w-56 rounded border bg-white px-1.5 font-mono transition-colors focus:ring-1 focus:outline-none'
                                    />
                                    <Button
                                        variant='ghost'
                                        size='sm'
                                        disabled={
                                            busy !== null ||
                                            !(
                                                addDrafts[
                                                    provider.builtInId
                                                ] ?? ''
                                            ).trim()
                                        }
                                        onClick={() => void addModel(provider)}
                                    >
                                        {busy === `add:${provider.builtInId}`
                                            ? 'Adding…'
                                            : 'Add model'}
                                    </Button>
                                </div>
                            </div>

                            {models.length === 0 ? (
                                <p className='text-caption text-body px-2 py-2'>
                                    {provider.models.length === 0
                                        ? 'No models observed yet — they appear once a user key reports its list, or add one by hand.'
                                        : 'No models match the filter.'}
                                </p>
                            ) : (
                                <div className='overflow-x-auto'>
                                    <table className='admin-table'>
                                        <thead>
                                            <tr>
                                                <th>Model</th>
                                                <th className='text-right'>
                                                    Observed
                                                </th>
                                                <th>Price source</th>
                                                {priceFields.map((field) => (
                                                    <th
                                                        key={field.key}
                                                        className='text-right'
                                                    >
                                                        {field.label} / token
                                                    </th>
                                                ))}
                                                <th />
                                            </tr>
                                        </thead>
                                        <tbody className='divide-border divide-y'>
                                            {models.flatMap((entry) => {
                                                const key = entryKey(
                                                    provider.builtInId,
                                                    entry.modelId
                                                )
                                                const draft =
                                                    drafts[key] ??
                                                    draftForPrices(
                                                        entry.prices
                                                    )
                                                const dirty = Boolean(
                                                    drafts[key]
                                                )
                                                const configured =
                                                    entry.pin !== null ||
                                                    Object.values(
                                                        entry.prices
                                                    ).some(
                                                        (v) => v !== null
                                                    ) ||
                                                    entry.observedCount === 0
                                                const rows: ReactNode[] = [
                                                    <tr key={key}>
                                                        <td className='font-mono'>
                                                            {entry.modelId}
                                                        </td>
                                                        <td className='text-body text-right'>
                                                            {entry.observedCount >
                                                            0 ? (
                                                                `${entry.observedCount}×`
                                                            ) : (
                                                                <Badge tone='neutral'>
                                                                    manual
                                                                </Badge>
                                                            )}
                                                        </td>
                                                        <td>
                                                            <PriceSourceCell
                                                                modelId={
                                                                    entry.modelId
                                                                }
                                                                priceStatus={
                                                                    entry.priceStatus
                                                                }
                                                                priceRef={
                                                                    entry.priceRef
                                                                }
                                                                expanded={
                                                                    openKey ===
                                                                    key
                                                                }
                                                                onToggle={() =>
                                                                    toggleSources(
                                                                        provider,
                                                                        entry
                                                                    )
                                                                }
                                                            />
                                                        </td>
                                                        {priceFields.map(
                                                            (field) => (
                                                                <td
                                                                    key={
                                                                        field.key
                                                                    }
                                                                    className='text-right'
                                                                >
                                                                    <input
                                                                        type='text'
                                                                        inputMode='decimal'
                                                                        value={
                                                                            draft[
                                                                                field
                                                                                    .key
                                                                            ]
                                                                        }
                                                                        placeholder={
                                                                            entry.resolvedPrice
                                                                                ? String(
                                                                                      entry
                                                                                          .resolvedPrice[
                                                                                          field
                                                                                              .key
                                                                                      ] ??
                                                                                          ''
                                                                                  )
                                                                                : ''
                                                                        }
                                                                        onChange={(
                                                                            e
                                                                        ) =>
                                                                            editPrice(
                                                                                key,
                                                                                entry,
                                                                                field.key,
                                                                                e
                                                                                    .target
                                                                                    .value
                                                                            )
                                                                        }
                                                                        aria-label={`${entry.modelId} ${field.label} cost per token`}
                                                                        className='tnum border-border text-caption text-heading focus:border-brand focus:ring-brand h-7 w-28 rounded border bg-white px-1.5 text-right transition-colors focus:ring-1 focus:outline-none'
                                                                    />
                                                                </td>
                                                            )
                                                        )}
                                                        <td className='text-right whitespace-nowrap'>
                                                            <Button
                                                                variant='ghost'
                                                                size='sm'
                                                                disabled={
                                                                    !dirty ||
                                                                    busy !==
                                                                        null
                                                                }
                                                                onClick={() =>
                                                                    void savePrices(
                                                                        provider,
                                                                        entry
                                                                    )
                                                                }
                                                            >
                                                                {busy ===
                                                                `prices:${key}`
                                                                    ? 'Saving…'
                                                                    : 'Save'}
                                                            </Button>
                                                            {configured && (
                                                                <Button
                                                                    variant='neutral'
                                                                    size='sm'
                                                                    className='ml-1'
                                                                    disabled={
                                                                        busy !==
                                                                        null
                                                                    }
                                                                    onClick={() =>
                                                                        void removeEntry(
                                                                            provider,
                                                                            entry
                                                                        )
                                                                    }
                                                                >
                                                                    {busy ===
                                                                    `remove:${key}`
                                                                        ? 'Removing…'
                                                                        : 'Remove'}
                                                                </Button>
                                                            )}
                                                        </td>
                                                    </tr>
                                                ]
                                                if (openKey === key)
                                                    rows.push(
                                                        <PriceCandidatesPanel
                                                            key={`${key}-sources`}
                                                            modelId={
                                                                entry.modelId
                                                            }
                                                            colSpan={
                                                                priceFields.length +
                                                                4
                                                            }
                                                            sources={sources}
                                                            loading={
                                                                busy ===
                                                                `sources:${key}`
                                                            }
                                                            busy={
                                                                busy !== null
                                                            }
                                                            query={sourceQuery}
                                                            onQueryChange={
                                                                setSourceQuery
                                                            }
                                                            onSearch={() =>
                                                                loadSources(
                                                                    provider.builtInId,
                                                                    entry.modelId,
                                                                    sourceQuery ||
                                                                        undefined
                                                                )
                                                            }
                                                            activeRef={
                                                                entry.priceRef
                                                            }
                                                            canClearPin={
                                                                entry.pin !==
                                                                null
                                                            }
                                                            onClearPin={() =>
                                                                void pinSource(
                                                                    provider,
                                                                    entry,
                                                                    null
                                                                )
                                                            }
                                                            onPin={(
                                                                candidate
                                                            ) =>
                                                                void pinSource(
                                                                    provider,
                                                                    entry,
                                                                    candidate
                                                                )
                                                            }
                                                        />
                                                    )
                                                return rows
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </Card>
                    )
                })}
            </div>
        </div>
    )
}

export default BuiltInModelPricesPage
