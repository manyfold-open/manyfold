import type {
    AdminSkillCatalogItem,
    CatalogCategorySummary
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { Fragment, useCallback, useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { Badge, Button, Card, Heading, Input } from '@/ui'

const PAGE_SIZE = 50

const selectClass =
    'border-border text-body text-heading focus:border-brand focus:ring-brand h-10 w-full rounded border bg-white px-2 transition-colors focus:ring-1 focus:outline-none'

interface CurationDraft {
    categoryId: string
    tagsText: string
    featured: boolean
    hidden: boolean
}

const draftFromItem = (item: AdminSkillCatalogItem): CurationDraft => ({
    categoryId: item.categoryId ?? '',
    tagsText: item.tags.join(', '),
    featured: item.featured,
    hidden: item.hidden
})

const SkillsCatalogList: FC = (): ReactNode => {
    const client = useApiClient()
    const [items, setItems] = useState<AdminSkillCatalogItem[] | null>(null)
    const [nextCursor, setNextCursor] = useState<string | null>(null)
    const [categories, setCategories] = useState<CatalogCategorySummary[]>([])
    const [q, setQ] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [draft, setDraft] = useState<CurationDraft | null>(null)
    const [saving, setSaving] = useState(false)

    const fetchPage = useCallback(
        async (opts: { append: boolean; cursor: string | null }) => {
            setLoading(true)
            setError(null)
            try {
                const page = await client.admin.skillsCatalog.list({
                    q: q.trim() || undefined,
                    cursor: opts.cursor ?? undefined,
                    limit: PAGE_SIZE
                })
                setItems((prev) =>
                    opts.append && prev
                        ? [...prev, ...page.items]
                        : page.items
                )
                setNextCursor(page.nextCursor)
            } catch (err) {
                setError((err as Error).message)
            } finally {
                setLoading(false)
            }
        },
        [client, q]
    )

    useEffect(() => {
        void fetchPage({ append: false, cursor: null })
    }, [client])

    useEffect(() => {
        client.admin.catalogCategories
            .list({ domain: 'skill' })
            .then(setCategories)
            .catch(() => {
                // best-effort — category select will just be empty
            })
    }, [client])

    const submit = (e: FormEvent<HTMLFormElement>): void => {
        e.preventDefault()
        setEditingId(null)
        void fetchPage({ append: false, cursor: null })
    }

    const startEdit = (item: AdminSkillCatalogItem): void => {
        setEditingId(item.skillId)
        setDraft(draftFromItem(item))
    }

    const saveDraft = async (item: AdminSkillCatalogItem): Promise<void> => {
        if (!draft) return
        setSaving(true)
        setError(null)
        try {
            const updated = await client.admin.skillsCatalog.update(
                item.skillId,
                {
                    categoryId: draft.categoryId || null,
                    tags: [
                        ...new Set(
                            draft.tagsText
                                .split(',')
                                .map((tag) => tag.trim())
                                .filter(Boolean)
                        )
                    ],
                    featured: draft.featured,
                    hidden: draft.hidden
                }
            )
            setItems(
                (prev) =>
                    prev?.map((row) =>
                        row.skillId === updated.skillId ? updated : row
                    ) ?? null
            )
            setEditingId(null)
            setDraft(null)
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className='mx-auto max-w-none'>
            <div className='mb-3'>
                <Heading level={2} className='mb-2'>
                    Skills catalog
                </Heading>
                <p className='admin-page-description max-w-2xl'>
                    Skills discovered from built-in and user repos. Rows are
                    owned by discovery — curate category, tags, featured and
                    hidden here. Hidden skills disappear from the user-facing
                    catalog but stay installable by explicit id.
                </p>
            </div>

            <form onSubmit={submit} className='mb-2 flex items-end gap-2'>
                <div className='w-72'>
                    <Input
                        id='q'
                        label='Search'
                        placeholder='Name, description, repo or path'
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                    />
                </div>
                <Button type='submit' variant='neutral' size='md'>
                    Search
                </Button>
            </form>

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

            {items === null && !error && (
                <p className='text-caption text-body'>Loading…</p>
            )}

            {items && items.length === 0 && (
                <div className='border-border-dashed rounded-lg border border-dashed bg-white p-4 text-center'>
                    <p className='admin-page-description'>
                        No skills match. Discovery fills this list from the
                        built-in and user skill repos.
                    </p>
                </div>
            )}

            {items && items.length > 0 && (
                <Card elevation='ambient' className='overflow-hidden'>
                    <div className='overflow-x-auto'>
                        <table className='admin-table w-full min-w-[1080px] text-left'>
                            <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b tracking-wider uppercase'>
                                <tr>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Name
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Repo
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Path
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Category
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Tags
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Flags
                                    </th>
                                    <th className='px-2 py-1.5 text-right font-normal' />
                                </tr>
                            </thead>
                            <tbody className='divide-border divide-y'>
                                {items.map((item) => (
                                    <Fragment key={item.skillId}>
                                        <tr className='text-caption text-heading hover:bg-surface-muted transition-colors'>
                                            <td className='px-2 py-1.5'>
                                                {item.name}
                                            </td>
                                            <td className='px-2 py-1.5 font-mono'>
                                                {item.repoOwner}/{item.repoName}
                                                @{item.repoBranch}
                                            </td>
                                            <td className='max-w-48 truncate px-2 py-1.5 font-mono'>
                                                {item.sourcePath}
                                            </td>
                                            <td className='px-2 py-1.5'>
                                                {item.category?.name ?? '—'}
                                            </td>
                                            <td className='px-2 py-1.5'>
                                                <div className='flex flex-wrap gap-1'>
                                                    {item.tags.length === 0 &&
                                                        '—'}
                                                    {item.tags.map((tag) => (
                                                        <Badge
                                                            key={tag}
                                                            tone='neutral'
                                                        >
                                                            {tag}
                                                        </Badge>
                                                    ))}
                                                </div>
                                            </td>
                                            <td className='px-2 py-1.5'>
                                                <div className='flex flex-wrap gap-1'>
                                                    {item.featured && (
                                                        <Badge tone='brand'>
                                                            featured
                                                        </Badge>
                                                    )}
                                                    {item.hidden && (
                                                        <Badge tone='neutral'>
                                                            hidden
                                                        </Badge>
                                                    )}
                                                    {!item.featured &&
                                                        !item.hidden &&
                                                        '—'}
                                                </div>
                                            </td>
                                            <td className='px-2 py-1.5 text-right whitespace-nowrap'>
                                                <Button
                                                    variant='ghost'
                                                    size='sm'
                                                    onClick={() =>
                                                        editingId ===
                                                        item.skillId
                                                            ? setEditingId(
                                                                  null
                                                              )
                                                            : startEdit(item)
                                                    }
                                                >
                                                    {editingId === item.skillId
                                                        ? 'Cancel'
                                                        : 'Edit'}
                                                </Button>
                                            </td>
                                        </tr>
                                        {editingId === item.skillId &&
                                            draft && (
                                                <tr className='bg-surface-subtle'>
                                                    <td
                                                        colSpan={7}
                                                        className='px-2 py-2'
                                                    >
                                                        <div className='grid items-end gap-2 md:grid-cols-[200px_minmax(0,1fr)_auto_auto_auto]'>
                                                            <div>
                                                                <label
                                                                    htmlFor={`${item.skillId}-category`}
                                                                    className='text-caption text-label mb-1 block font-normal'
                                                                >
                                                                    Category
                                                                </label>
                                                                <select
                                                                    id={`${item.skillId}-category`}
                                                                    className={
                                                                        selectClass
                                                                    }
                                                                    value={
                                                                        draft.categoryId
                                                                    }
                                                                    onChange={(
                                                                        e
                                                                    ) =>
                                                                        setDraft(
                                                                            {
                                                                                ...draft,
                                                                                categoryId:
                                                                                    e
                                                                                        .target
                                                                                        .value
                                                                            }
                                                                        )
                                                                    }
                                                                >
                                                                    <option value=''>
                                                                        No
                                                                        category
                                                                    </option>
                                                                    {categories.map(
                                                                        (
                                                                            category
                                                                        ) => (
                                                                            <option
                                                                                key={
                                                                                    category.id
                                                                                }
                                                                                value={
                                                                                    category.id
                                                                                }
                                                                            >
                                                                                {
                                                                                    category.name
                                                                                }
                                                                            </option>
                                                                        )
                                                                    )}
                                                                </select>
                                                            </div>
                                                            <Input
                                                                id={`${item.skillId}-tags`}
                                                                label='Tags (comma-separated)'
                                                                value={
                                                                    draft.tagsText
                                                                }
                                                                onChange={(
                                                                    e
                                                                ) =>
                                                                    setDraft({
                                                                        ...draft,
                                                                        tagsText:
                                                                            e
                                                                                .target
                                                                                .value
                                                                    })
                                                                }
                                                            />
                                                            <label className='text-caption text-label flex items-center gap-2 pb-2'>
                                                                <input
                                                                    type='checkbox'
                                                                    checked={
                                                                        draft.featured
                                                                    }
                                                                    onChange={(
                                                                        e
                                                                    ) =>
                                                                        setDraft(
                                                                            {
                                                                                ...draft,
                                                                                featured:
                                                                                    e
                                                                                        .target
                                                                                        .checked
                                                                            }
                                                                        )
                                                                    }
                                                                />
                                                                Featured
                                                            </label>
                                                            <label className='text-caption text-label flex items-center gap-2 pb-2'>
                                                                <input
                                                                    type='checkbox'
                                                                    checked={
                                                                        draft.hidden
                                                                    }
                                                                    onChange={(
                                                                        e
                                                                    ) =>
                                                                        setDraft(
                                                                            {
                                                                                ...draft,
                                                                                hidden: e
                                                                                    .target
                                                                                    .checked
                                                                            }
                                                                        )
                                                                    }
                                                                />
                                                                Hidden
                                                            </label>
                                                            <Button
                                                                variant='primary'
                                                                size='sm'
                                                                disabled={
                                                                    saving
                                                                }
                                                                onClick={() =>
                                                                    void saveDraft(
                                                                        item
                                                                    )
                                                                }
                                                            >
                                                                {saving
                                                                    ? 'Saving…'
                                                                    : 'Save'}
                                                            </Button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            )}
                                    </Fragment>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </Card>
            )}

            {items && nextCursor && (
                <div className='mt-3 flex justify-center'>
                    <Button
                        variant='ghost'
                        size='sm'
                        disabled={loading}
                        onClick={() =>
                            void fetchPage({
                                append: true,
                                cursor: nextCursor
                            })
                        }
                    >
                        {loading ? 'Loading…' : 'Load more'}
                    </Button>
                </div>
            )}
        </div>
    )
}

export default SkillsCatalogList
