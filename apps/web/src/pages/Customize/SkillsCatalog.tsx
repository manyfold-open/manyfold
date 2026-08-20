import type {
    CatalogCategorySummary,
    CatalogSort,
    DiscoverableSkillSummary
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { SkillsIcon } from '@/components/icons'
import { GithubMono } from '@/lib/brandIcons'
import EmptyState from '@/components/EmptyState'
import { HairlineProgress, Spinner } from '@/components/Loading'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { githubAvatarUrl } from '@/lib/githubAvatar'
import { useI18n } from '@/lib/i18n'
import { useLoadingGate } from '@/components/useLoadingGate'
import CatalogCard, { CatalogCardGhost } from './CatalogCard'
import CatalogSortTabs from './CatalogSortTabs'
import CustomizePageHeader from './CustomizePageHeader'

const PAGE_SIZE = 24
const GHOST_SEEDS = [0, 1, 2, 3, 4, 5]

export const skillDetailPath = (skillId: string): string =>
    `/skills/detail?id=${encodeURIComponent(skillId)}`

const SkillsCatalog: FC = (): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [categories, setCategories] = useState<CatalogCategorySummary[]>([])
    const [items, setItems] = useState<DiscoverableSkillSummary[]>([])
    const [nextCursor, setNextCursor] = useState<string | null>(null)
    const [query, setQuery] = useState('')
    const [categoryId, setCategoryId] = useState('')
    const [sort, setSort] = useState<CatalogSort>('featured')
    const [loading, setLoading] = useState(true)
    const [loadingMore, setLoadingMore] = useState(false)
    const [hasLoaded, setHasLoaded] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // §10.8: the first load ghosts the grid; a refetch over existing
    // results keeps them readable under a hairline instead.
    const initialGate = useLoadingGate(loading && !hasLoaded)
    const refreshGate = useLoadingGate(loading && hasLoaded)
    // Monotonic request token: fetches race (filter/sort/search fire without
    // cancelling in-flight requests), so only the latest one may touch state —
    // otherwise a slow earlier response overwrites a newer list out of order.
    const requestSeq = useRef(0)

    const fetchPage = async (opts: {
        append: boolean
        cursor: string | null
    }): Promise<void> => {
        const seq = ++requestSeq.current
        if (opts.append) setLoadingMore(true)
        else {
            // A fresh query/filter supersedes any in-flight "load more".
            setLoading(true)
            setLoadingMore(false)
        }
        setError(null)
        try {
            const page = await client.skills.discoverPage({
                q: query || undefined,
                category: categoryId || undefined,
                sort,
                cursor: opts.cursor ?? undefined,
                limit: PAGE_SIZE
            })
            if (seq !== requestSeq.current) return
            setItems((prev) =>
                opts.append ? [...prev, ...page.items] : page.items
            )
            setNextCursor(page.nextCursor)
            setHasLoaded(true)
        } catch (err) {
            if (seq !== requestSeq.current) return
            setError(apiErrorMessage(err))
        } finally {
            if (seq === requestSeq.current) {
                if (opts.append) setLoadingMore(false)
                else setLoading(false)
            }
        }
    }

    useEffect(() => {
        client.catalogCategories
            .list('skill')
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
            <CustomizePageHeader group='skills' />

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
                    placeholder={t('web.skills.searchPlaceholder')}
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
                items.length === 0 &&
                !error && (
                    <EmptyState
                        kind='no-results'
                        tier='stack'
                        title={t('web.skills.noResultsTitle')}
                        body={t('web.skills.noResultsBody')}
                    />
                )}

            {!initialGate.showLoading && items.length > 0 && (
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
                        {items.map((skill) => (
                            <CatalogCard
                                key={skill.skillId}
                                to={skillDetailPath(skill.skillId)}
                                name={skill.name}
                                description={skill.description}
                                iconUrl={githubAvatarUrl(skill.repoOwner)}
                                fallbackIcon={
                                    <SkillsIcon className='h-4 w-4' />
                                }
                                featured={skill.featured}
                                featuredLabel={t('web.customize.featuredBadge')}
                                categoryName={skill.category?.name}
                                tags={skill.tags}
                                meta={`${skill.repoOwner}/${skill.repoName}`}
                                sourceIcon={<GithubMono size={16} />}
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

export default SkillsCatalog
