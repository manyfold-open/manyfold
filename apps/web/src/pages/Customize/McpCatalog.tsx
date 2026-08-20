import type {
    CatalogCategorySummary,
    CatalogSort,
    McpCatalogEntry
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { McpIcon } from '@/components/icons'
import EmptyState from '@/components/EmptyState'
import { HairlineProgress, Spinner } from '@/components/Loading'
import { useLoadingGate } from '@/components/useLoadingGate'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { githubAvatarUrlFromRepositoryUrl } from '@/lib/githubAvatar'
import { useI18n } from '@/lib/i18n'
import CatalogCard, { CatalogCardGhost } from './CatalogCard'
import CatalogSortTabs from './CatalogSortTabs'
import CustomizePageHeader from './CustomizePageHeader'

const PAGE_SIZE = 24
const GHOST_SEEDS = [0, 1, 2, 3, 4, 5]

export const mcpTransportLabel = (
    t: (key: string) => string,
    transport: McpCatalogEntry['transport']
): string =>
    t(
        transport === 'http'
            ? 'web.customize.transportHttp'
            : 'web.customize.transportStdio'
    )

const McpCatalog: FC = (): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [categories, setCategories] = useState<CatalogCategorySummary[]>([])
    const [entries, setEntries] = useState<McpCatalogEntry[]>([])
    const [nextCursor, setNextCursor] = useState<string | null>(null)
    const [query, setQuery] = useState('')
    const [categoryId, setCategoryId] = useState('')
    const [sort, setSort] = useState<CatalogSort>('featured')
    const [loading, setLoading] = useState(true)
    const [loadingMore, setLoadingMore] = useState(false)
    const [hasLoaded, setHasLoaded] = useState(false)
    // §10.8: cold load ghosts the grid; a refetch keeps results readable.
    const initialGate = useLoadingGate(loading && !hasLoaded)
    const refreshGate = useLoadingGate(loading && hasLoaded)
    const [error, setError] = useState<string | null>(null)

    const fetchPage = async (opts: {
        append: boolean
        cursor: string | null
    }): Promise<void> => {
        if (opts.append) setLoadingMore(true)
        else setLoading(true)
        setError(null)
        try {
            const page = await client.mcp.catalog({
                q: query || undefined,
                category: categoryId || undefined,
                sort,
                cursor: opts.cursor ?? undefined,
                limit: PAGE_SIZE
            })
            setEntries((prev) =>
                opts.append ? [...prev, ...page.items] : page.items
            )
            setNextCursor(page.nextCursor)
            setHasLoaded(true)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            if (opts.append) setLoadingMore(false)
            else setLoading(false)
        }
    }

    useEffect(() => {
        client.catalogCategories
            .list('mcp')
            .then(setCategories)
            .catch(() => {
                // best-effort — category filter will just be empty
            })
    }, [client])

    useEffect(() => {
        void fetchPage({ append: false, cursor: null })
    }, [client, categoryId, sort])

    const submit = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault()
        void fetchPage({ append: false, cursor: null })
    }

    return (
        <>
            <CustomizePageHeader group='mcp' />

            {error && <div className='workbench-alert-error mb-5'>{error}</div>}

            <form
                onSubmit={submit}
                className='mb-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_auto]'
            >
                <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    disabled={loading}
                    className='workbench-input'
                    placeholder={t('web.customize.mcpSearchPlaceholder')}
                />
                <WorkbenchSelect
                    ariaLabel={t('web.customize.allCategories')}
                    value={categoryId}
                    onChange={setCategoryId}
                    disabled={loading}
                    options={[
                        { value: '', label: t('web.customize.allCategories') },
                        ...categories.map((category) => ({
                            value: category.id,
                            label: category.name
                        }))
                    ]}
                />
                <button
                    type='submit'
                    disabled={loading}
                    className='workbench-button-primary'
                >
                    {t('web.skills.searchAction')}
                </button>
            </form>

            <div className='mb-4'>
                <CatalogSortTabs value={sort} onChange={setSort} />
            </div>

            {initialGate.showLoading && (
                <div
                    aria-busy='true'
                    className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'
                >
                    {GHOST_SEEDS.map((seed) => (
                        <CatalogCardGhost key={seed} seed={seed} />
                    ))}
                </div>
            )}

            {!loading &&
                !initialGate.showLoading &&
                entries.length === 0 &&
                !error && (
                    <EmptyState
                        kind='no-results'
                        tier='stack'
                        title={t('web.customize.mcpEmptyTitle')}
                        body={t('web.customize.mcpEmptyBody')}
                    />
                )}

            {!initialGate.showLoading && entries.length > 0 && (
                <div className='relative'>
                    {refreshGate.showLoading && (
                        <HairlineProgress className='absolute inset-x-0 -top-2.5' />
                    )}
                    <div
                        className={
                            initialGate.fadeIn
                                ? 'loading-fade-in grid gap-3 sm:grid-cols-2 lg:grid-cols-3'
                                : 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3'
                        }
                    >
                        {entries.map((entry) => (
                            <CatalogCard
                                key={entry.id}
                                to={`/mcp/${entry.id}`}
                                name={entry.name}
                                description={entry.description}
                                iconUrl={
                                    entry.iconUrl ??
                                    githubAvatarUrlFromRepositoryUrl(
                                        entry.homepageUrl
                                    )
                                }
                                fallbackIcon={<McpIcon className='h-4 w-4' />}
                                featured={entry.featured}
                                featuredLabel={t('web.customize.featuredBadge')}
                                categoryName={entry.category?.name}
                                tags={[
                                    mcpTransportLabel(t, entry.transport),
                                    ...entry.tags
                                ]}
                            />
                        ))}
                    </div>
                </div>
            )}

            {!loading && nextCursor && (
                <div className='mt-6 flex justify-center'>
                    <button
                        type='button'
                        onClick={() =>
                            void fetchPage({ append: true, cursor: nextCursor })
                        }
                        disabled={loadingMore}
                        className='workbench-button-secondary h-10 px-4'
                    >
                        {loadingMore ? (
                            <>
                                <Spinner size={16} className='mr-2' />
                                {t('web.customize.loadingMore')}
                            </>
                        ) : (
                            t('web.customize.loadMore')
                        )}
                    </button>
                </div>
            )}
        </>
    )
}

export default McpCatalog
