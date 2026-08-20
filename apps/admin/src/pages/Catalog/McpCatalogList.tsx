import type { AdminMcpCatalogEntry } from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useApiClient } from '@/lib/apiClient'
import { adminRoutes } from '@/routes'
import { Badge, Button, ButtonLink, Card, Heading, Input } from '@/ui'

const PAGE_SIZE = 50

const McpCatalogList: FC = (): ReactNode => {
    const client = useApiClient()
    const navigate = useNavigate()
    const [items, setItems] = useState<AdminMcpCatalogEntry[] | null>(null)
    const [nextCursor, setNextCursor] = useState<string | null>(null)
    const [q, setQ] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [busyId, setBusyId] = useState<string | null>(null)

    const fetchPage = useCallback(
        async (opts: { append: boolean; cursor: string | null }) => {
            setLoading(true)
            setError(null)
            try {
                const page = await client.admin.mcpCatalog.list({
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

    const submit = (e: FormEvent<HTMLFormElement>): void => {
        e.preventDefault()
        void fetchPage({ append: false, cursor: null })
    }

    const onDelete = async (row: AdminMcpCatalogEntry): Promise<void> => {
        if (
            !window.confirm(
                `Delete MCP catalog entry "${row.name}" (${row.slug})?`
            )
        )
            return
        setBusyId(row.id)
        try {
            await client.admin.mcpCatalog.delete(row.id)
            void fetchPage({ append: false, cursor: null })
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusyId(null)
        }
    }

    return (
        <div className='mx-auto max-w-none'>
            <div className='mb-3 flex items-start justify-between gap-2'>
                <div>
                    <Heading level={2} className='mb-2'>
                        MCP catalog
                    </Heading>
                    <p className='admin-page-description max-w-2xl'>
                        Servers listed on the user-facing MCP catalog. Inactive
                        entries stay here but disappear from the public list.
                    </p>
                </div>
                <ButtonLink variant='primary' to={adminRoutes.mcpCatalogNew}>
                    New entry
                </ButtonLink>
            </div>

            <form onSubmit={submit} className='mb-2 flex items-end gap-2'>
                <div className='w-72'>
                    <Input
                        id='q'
                        label='Search'
                        placeholder='Name, slug or description'
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
                    <p className='admin-page-description mb-2'>
                        No entries match. Create one to publish it in the user
                        catalog.
                    </p>
                    <ButtonLink
                        variant='primary'
                        to={adminRoutes.mcpCatalogNew}
                    >
                        New entry
                    </ButtonLink>
                </div>
            )}

            {items && items.length > 0 && (
                <Card elevation='ambient' className='overflow-hidden'>
                    <div className='overflow-x-auto'>
                        <table className='admin-table w-full min-w-[960px] text-left'>
                            <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b tracking-wider uppercase'>
                                <tr>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Name
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Slug
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Transport
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Tags
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Featured
                                    </th>
                                    <th className='px-2 py-1.5 font-normal'>
                                        Active
                                    </th>
                                    <th className='px-2 py-1.5 text-right font-normal' />
                                </tr>
                            </thead>
                            <tbody className='divide-border divide-y'>
                                {items.map((row) => (
                                    <tr
                                        key={row.id}
                                        className='text-caption text-heading hover:bg-surface-muted transition-colors'
                                    >
                                        <td className='px-2 py-1.5'>
                                            <Link
                                                to={adminRoutes.mcpCatalogItem(
                                                    row.id
                                                )}
                                                className='hover:text-brand'
                                            >
                                                {row.name}
                                            </Link>
                                        </td>
                                        <td className='px-2 py-1.5 font-mono'>
                                            {row.slug}
                                        </td>
                                        <td className='px-2 py-1.5 font-mono'>
                                            {row.transport}
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            <div className='flex flex-wrap gap-1'>
                                                {row.tags.map((tag) => (
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
                                            {row.featured ? (
                                                <Badge tone='brand'>
                                                    featured
                                                </Badge>
                                            ) : (
                                                '—'
                                            )}
                                        </td>
                                        <td className='px-2 py-1.5'>
                                            <Badge
                                                tone={
                                                    row.isActive
                                                        ? 'success'
                                                        : 'neutral'
                                                }
                                            >
                                                {row.isActive
                                                    ? 'active'
                                                    : 'inactive'}
                                            </Badge>
                                        </td>
                                        <td className='px-2 py-1.5 text-right whitespace-nowrap'>
                                            <Button
                                                variant='ghost'
                                                size='sm'
                                                className='mr-2'
                                                onClick={() =>
                                                    navigate(
                                                        adminRoutes.mcpCatalogItem(
                                                            row.id
                                                        )
                                                    )
                                                }
                                            >
                                                Edit
                                            </Button>
                                            <Button
                                                variant='neutral'
                                                size='sm'
                                                disabled={busyId === row.id}
                                                onClick={() =>
                                                    void onDelete(row)
                                                }
                                            >
                                                Delete
                                            </Button>
                                        </td>
                                    </tr>
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

export default McpCatalogList