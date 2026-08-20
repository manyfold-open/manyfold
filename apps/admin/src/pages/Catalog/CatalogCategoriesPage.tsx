import type {
    CatalogCategorySummary,
    CatalogDomain
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { Button, Card, Heading, Input } from '@/ui'

interface DraftRow {
    id: string
    name: string
    sortOrder: string
}

const toDraft = (row: CatalogCategorySummary): DraftRow => ({
    id: row.id,
    name: row.name,
    sortOrder: String(row.sortOrder)
})

const CategorySection: FC<{ domain: CatalogDomain }> = ({
    domain
}): ReactNode => {
    const client = useApiClient()
    const [rows, setRows] = useState<DraftRow[]>([])
    const [newName, setNewName] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const load = useCallback((): void => {
        setError(null)
        client.admin.catalogCategories
            .list({ domain })
            .then((items) => setRows(items.map(toDraft)))
            .catch((err: Error) => setError(err.message))
    }, [client, domain])

    useEffect(load, [load])

    const updateRow = (index: number, patch: Partial<DraftRow>): void => {
        setRows((current) =>
            current.map((row, i) => (i === index ? { ...row, ...patch } : row))
        )
    }

    const saveRow = async (row: DraftRow): Promise<void> => {
        setBusy(true)
        setError(null)
        try {
            await client.admin.catalogCategories.update(row.id, {
                name: row.name.trim(),
                sortOrder: Number.parseInt(row.sortOrder, 10) || 0
            })
            load()
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    const deleteRow = async (row: DraftRow): Promise<void> => {
        if (
            !window.confirm(
                `Delete category "${row.name}"? Entries using it become uncategorized.`
            )
        )
            return
        setBusy(true)
        setError(null)
        try {
            await client.admin.catalogCategories.delete(row.id)
            load()
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    const addRow = async (): Promise<void> => {
        if (!newName.trim()) return
        setBusy(true)
        setError(null)
        try {
            await client.admin.catalogCategories.create({
                domain,
                name: newName.trim()
            })
            setNewName('')
            load()
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className='mb-4'>
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
            <Card elevation='ambient' className='p-3'>
                <div className='space-y-2'>
                    {rows.length === 0 && (
                        <p className='text-caption text-body'>
                            No categories yet.
                        </p>
                    )}
                    {rows.map((row, index) => (
                        <div
                            key={row.id}
                            className='border-border grid items-end gap-2 rounded border p-2 md:grid-cols-[minmax(0,1fr)_120px_auto_auto]'
                        >
                            <Input
                                id={`${row.id}-name`}
                                label='Name'
                                value={row.name}
                                onChange={(e) =>
                                    updateRow(index, { name: e.target.value })
                                }
                            />
                            <Input
                                id={`${row.id}-sort`}
                                label='Sort order'
                                type='number'
                                value={row.sortOrder}
                                onChange={(e) =>
                                    updateRow(index, {
                                        sortOrder: e.target.value
                                    })
                                }
                            />
                            <Button
                                variant='neutral'
                                size='sm'
                                disabled={busy || !row.name.trim()}
                                onClick={() => void saveRow(row)}
                            >
                                Save
                            </Button>
                            <Button
                                variant='ghost'
                                size='sm'
                                disabled={busy}
                                onClick={() => void deleteRow(row)}
                            >
                                Delete
                            </Button>
                        </div>
                    ))}
                    <div className='border-border grid items-end gap-2 rounded border border-dashed p-2 md:grid-cols-[minmax(0,1fr)_auto]'>
                        <Input
                            id={`${domain}-new-name`}
                            label='New category'
                            placeholder='e.g. Developer Tools'
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                        />
                        <Button
                            variant='primary'
                            size='sm'
                            disabled={busy || !newName.trim()}
                            onClick={() => void addRow()}
                        >
                            Add
                        </Button>
                    </div>
                </div>
            </Card>
        </div>
    )
}

const CatalogCategoriesPage: FC<{ domain: CatalogDomain }> = ({
    domain
}): ReactNode => {
    const catalogName = domain === 'skill' ? 'Skill' : 'MCP'

    return (
        <div className='mx-auto max-w-3xl'>
            <div className='mb-3'>
                <Heading level={2} className='mb-2'>
                    {catalogName} categories
                </Heading>
                <p className='admin-page-description'>
                    Categories power the filter dropdown on the user-facing{' '}
                    {catalogName} catalog. Deleting a category leaves its
                    entries uncategorized.
                </p>
            </div>
            <CategorySection domain={domain} />
        </div>
    )
}

export default CatalogCategoriesPage
