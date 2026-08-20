import type {
    ModelPriceAmounts,
    ModelPriceCandidate,
    ModelPriceRefView,
    ModelPriceSource,
    ModelPriceSourcesView,
    ModelPriceStatus
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { Badge, Button } from '@/ui'

export type PriceField =
    | 'inputCostPerToken'
    | 'outputCostPerToken'
    | 'cacheReadCostPerToken'
    | 'cacheCreationCostPerToken'

export const priceFields: Array<{ key: PriceField; label: string }> = [
    { key: 'inputCostPerToken', label: 'Input' },
    { key: 'outputCostPerToken', label: 'Output' },
    { key: 'cacheReadCostPerToken', label: 'Cache read' },
    { key: 'cacheCreationCostPerToken', label: 'Cache write' }
]

const priceStatusTone: Record<
    ModelPriceStatus,
    'brand' | 'neutral' | 'error'
> = {
    override: 'brand',
    litellm: 'neutral',
    models_dev: 'neutral',
    netmind: 'neutral',
    missing: 'error'
}

const priceStatusLabel: Record<ModelPriceStatus, string> = {
    override: 'override',
    litellm: 'litellm',
    models_dev: 'models.dev',
    netmind: 'NetMind',
    missing: 'no price'
}

export const sourceLabel: Record<ModelPriceSource, string> = {
    litellm: 'litellm',
    models_dev: 'models.dev',
    netmind: 'NetMind'
}

export const formatTime = (iso: string | null): string =>
    iso ? new Date(iso).toLocaleString() : 'never'

const draftValue = (value: number | null): string =>
    value === null ? '' : String(value)

export const draftForPrices = (
    prices: ModelPriceAmounts
): Record<PriceField, string> => ({
    inputCostPerToken: draftValue(prices.inputCostPerToken),
    outputCostPerToken: draftValue(prices.outputCostPerToken),
    cacheReadCostPerToken: draftValue(prices.cacheReadCostPerToken),
    cacheCreationCostPerToken: draftValue(prices.cacheCreationCostPerToken)
})

// Turn one drafted field set into PUT/PATCH price fields, or a string error.
export const parsePriceDraft = (
    draft: Record<PriceField, string>
): Record<PriceField, number | null> | string => {
    const body: Record<PriceField, number | null> = {
        inputCostPerToken: null,
        outputCostPerToken: null,
        cacheReadCostPerToken: null,
        cacheCreationCostPerToken: null
    }
    for (const { key, label } of priceFields) {
        const raw = draft[key].trim()
        if (raw.length === 0) continue
        const parsed = Number(raw)
        if (!Number.isFinite(parsed) || parsed < 0)
            return `${label} must be a number ≥ 0`
        body[key] = parsed
    }
    return body
}

// Per-token rates run to 1e-7, which is unreadable in a list. The candidate panel
// shows the per-million figure vendors actually publish; the editable inputs stay
// per token so nobody can confuse the two units while typing a price.
const perMillion = (value: number | null): string =>
    value === null ? '—' : `$${Number((value * 1_000_000).toFixed(4))}`

const SourceLink: FC<{ url: string; children: ReactNode }> = ({
    url,
    children
}): ReactNode => (
    <a
        href={url}
        target='_blank'
        rel='noreferrer'
        className='text-brand hover:text-brand-hover'
    >
        {children} ↗
    </a>
)

// The "price source" cell body: status badge, pinned marker, the matched record
// and a link out to it. Clicking toggles the candidates panel.
export const PriceSourceCell: FC<{
    modelId: string
    priceStatus: ModelPriceStatus
    priceRef: ModelPriceRefView | null
    expanded: boolean
    onToggle: () => void
}> = ({ modelId, priceStatus, priceRef, expanded, onToggle }): ReactNode => (
    <>
        <button
            type='button'
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={`price source for ${modelId}`}
            className='flex flex-col items-start gap-0.5 text-left'
        >
            <span className='flex items-center gap-1'>
                <Badge tone={priceStatusTone[priceStatus]}>
                    {priceStatusLabel[priceStatus]}
                </Badge>
                {priceRef?.pinned && <Badge tone='brand'>pinned</Badge>}
            </span>
            {priceRef && (
                <span className='text-caption-sm text-body font-mono'>
                    {priceRef.key}
                </span>
            )}
        </button>
        {priceRef && (
            <div className='text-caption-sm'>
                <SourceLink url={priceRef.url}>
                    {sourceLabel[priceRef.source]}
                </SourceLink>
            </div>
        )}
    </>
)

// The expandable association picker: table freshness, a search over both
// tables, and pick-to-pin. Rendered as a full-width row under the model's row.
export const PriceCandidatesPanel: FC<{
    modelId: string
    colSpan: number
    sources: ModelPriceSourcesView | null
    loading: boolean
    busy: boolean
    query: string
    onQueryChange: (value: string) => void
    onSearch: () => void
    activeRef: ModelPriceRefView | null
    canClearPin: boolean
    onClearPin: () => void
    onPin: (candidate: ModelPriceCandidate) => void
}> = ({
    modelId,
    colSpan,
    sources,
    loading,
    busy,
    query,
    onQueryChange,
    onSearch,
    activeRef,
    canClearPin,
    onClearPin,
    onPin
}): ReactNode => (
    <tr className='bg-surface-muted'>
        <td colSpan={colSpan} className='px-2 py-2'>
            <div className='mb-1.5 flex flex-wrap items-center gap-2'>
                <span className='text-caption-sm text-body'>
                    Pricing records for{' '}
                    <span className='font-mono'>{modelId}</span>
                </span>
                {(sources?.sources ?? []).map((source) => (
                    <Badge key={source.source} tone='neutral'>
                        {sourceLabel[source.source]} · {source.entryCount}{' '}
                        models · {formatTime(source.fetchedAt)}
                    </Badge>
                ))}
                <input
                    type='text'
                    value={query}
                    placeholder='search both tables…'
                    onChange={(e) => onQueryChange(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') onSearch()
                    }}
                    aria-label={`search pricing records for ${modelId}`}
                    className='border-border text-caption text-heading focus:border-brand focus:ring-brand h-7 w-56 rounded border bg-white px-1.5 transition-colors focus:ring-1 focus:outline-none'
                />
                <Button
                    variant='ghost'
                    size='sm'
                    disabled={busy}
                    onClick={onSearch}
                >
                    Search
                </Button>
                <Button
                    variant='neutral'
                    size='sm'
                    disabled={busy || !canClearPin}
                    onClick={onClearPin}
                >
                    Use automatic
                </Button>
            </div>

            {!sources && loading && (
                <p className='text-caption-sm text-body'>Loading…</p>
            )}

            {sources && sources.candidates.length === 0 && (
                <p className='text-caption-sm text-body'>
                    Neither table has a record for this id. Search for one, or
                    type a price instead.
                </p>
            )}

            {sources && sources.candidates.length > 0 && (
                <table className='admin-table'>
                    <thead>
                        <tr>
                            <th>Source</th>
                            <th>Record</th>
                            <th>Match</th>
                            {priceFields.map((field) => (
                                <th key={field.key} className='text-right'>
                                    {field.label} / 1M
                                </th>
                            ))}
                            <th />
                        </tr>
                    </thead>
                    <tbody className='divide-border divide-y'>
                        {sources.candidates.map((candidate) => {
                            const active =
                                activeRef?.source === candidate.source &&
                                activeRef?.key === candidate.key
                            return (
                                <tr
                                    key={`${candidate.source}:${candidate.key}`}
                                >
                                    <td>{sourceLabel[candidate.source]}</td>
                                    <td className='font-mono'>
                                        <SourceLink url={candidate.url}>
                                            {candidate.key}
                                        </SourceLink>
                                    </td>
                                    <td>
                                        <Badge
                                            tone={
                                                candidate.matchKind === 'exact'
                                                    ? 'success'
                                                    : 'neutral'
                                            }
                                        >
                                            {candidate.matchKind}
                                        </Badge>
                                        {!candidate.official && (
                                            <Badge
                                                tone='warning'
                                                className='ml-1'
                                            >
                                                third party
                                            </Badge>
                                        )}
                                    </td>
                                    {priceFields.map((field) => (
                                        <td
                                            key={field.key}
                                            className='tnum text-right'
                                        >
                                            {perMillion(
                                                candidate.prices[field.key]
                                            )}
                                        </td>
                                    ))}
                                    <td className='text-right'>
                                        {active ? (
                                            <Badge tone='brand'>in use</Badge>
                                        ) : (
                                            <Button
                                                variant='ghost'
                                                size='sm'
                                                disabled={busy}
                                                onClick={() =>
                                                    onPin(candidate)
                                                }
                                            >
                                                Use this
                                            </Button>
                                        )}
                                    </td>
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
            )}
        </td>
    </tr>
)
