import type {
    CatalogCategorySummary,
    McpCatalogTransport,
    UpdateMcpCatalogEntryBody
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useApiClient } from '@/lib/apiClient'
import { adminRoutes } from '@/routes'
import {
    Breadcrumbs,
    Button,
    Card,
    CardBody,
    DetailPage,
    Heading,
    Input
} from '@/ui'

const selectClass =
    'border-border text-body text-heading focus:border-brand focus:ring-brand h-10 w-full rounded border bg-white px-2 transition-colors focus:ring-1 focus:outline-none'

const textareaClass =
    'border-border text-caption text-heading focus:border-brand focus:ring-brand placeholder:text-body/50 block w-full rounded border bg-white px-3 py-2 focus:ring-1 focus:outline-none'

interface Pair {
    key: string
    value: string
}

const pairsFromRecord = (record: Record<string, string> | null): Pair[] =>
    Object.entries(record ?? {}).map(([key, value]) => ({ key, value }))

const recordFromPairs = (pairs: Pair[]): Record<string, string> | undefined => {
    const entries = pairs
        .map((pair) => [pair.key.trim(), pair.value] as const)
        .filter(([key]) => key.length > 0)
    if (entries.length === 0) return undefined
    return Object.fromEntries(entries)
}

const KeyValueRows: FC<{
    label: string
    hint?: string
    pairs: Pair[]
    onChange: (pairs: Pair[]) => void
}> = ({ label, hint, pairs, onChange }): ReactNode => (
    <div>
        <span className='text-caption text-label mb-1 block font-normal'>
            {label}
        </span>
        <div className='space-y-2'>
            {pairs.map((pair, index) => (
                <div
                    key={index}
                    className='grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] items-center gap-2'
                >
                    <Input
                        id={`${label}-${index}-key`}
                        placeholder='Key'
                        value={pair.key}
                        onChange={(e) =>
                            onChange(
                                pairs.map((p, i) =>
                                    i === index
                                        ? { ...p, key: e.target.value }
                                        : p
                                )
                            )
                        }
                    />
                    <Input
                        id={`${label}-${index}-value`}
                        placeholder='Value'
                        value={pair.value}
                        onChange={(e) =>
                            onChange(
                                pairs.map((p, i) =>
                                    i === index
                                        ? { ...p, value: e.target.value }
                                        : p
                                )
                            )
                        }
                    />
                    <Button
                        variant='ghost'
                        size='sm'
                        onClick={() =>
                            onChange(pairs.filter((_, i) => i !== index))
                        }
                    >
                        Remove
                    </Button>
                </div>
            ))}
            <Button
                variant='neutral'
                size='sm'
                onClick={() => onChange([...pairs, { key: '', value: '' }])}
            >
                Add row
            </Button>
        </div>
        {hint && <p className='text-caption-sm text-body mt-1'>{hint}</p>}
    </div>
)

const StringListRows: FC<{
    label: string
    hint?: string
    values: string[]
    onChange: (values: string[]) => void
}> = ({ label, hint, values, onChange }): ReactNode => (
    <div>
        <span className='text-caption text-label mb-1 block font-normal'>
            {label}
        </span>
        <div className='space-y-2'>
            {values.map((value, index) => (
                <div
                    key={index}
                    className='grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2'
                >
                    <Input
                        id={`${label}-${index}`}
                        placeholder='Value'
                        value={value}
                        onChange={(e) =>
                            onChange(
                                values.map((v, i) =>
                                    i === index ? e.target.value : v
                                )
                            )
                        }
                    />
                    <Button
                        variant='ghost'
                        size='sm'
                        onClick={() =>
                            onChange(values.filter((_, i) => i !== index))
                        }
                    >
                        Remove
                    </Button>
                </div>
            ))}
            <Button
                variant='neutral'
                size='sm'
                onClick={() => onChange([...values, ''])}
            >
                Add row
            </Button>
        </div>
        {hint && <p className='text-caption-sm text-body mt-1'>{hint}</p>}
    </div>
)

const McpCatalogForm: FC = (): ReactNode => {
    const { id } = useParams<{ id?: string }>()
    const isEdit = Boolean(id)
    const client = useApiClient()
    const navigate = useNavigate()

    const [categories, setCategories] = useState<CatalogCategorySummary[]>([])
    const [name, setName] = useState('')
    const [slug, setSlug] = useState('')
    const [description, setDescription] = useState('')
    const [longDescription, setLongDescription] = useState('')
    const [homepageUrl, setHomepageUrl] = useState('')
    const [iconUrl, setIconUrl] = useState('')
    const [transport, setTransport] = useState<McpCatalogTransport>('http')
    const [url, setUrl] = useState('')
    const [headers, setHeaders] = useState<Pair[]>([])
    const [command, setCommand] = useState('')
    const [args, setArgs] = useState<string[]>([])
    const [env, setEnv] = useState<Pair[]>([])
    const [tagsText, setTagsText] = useState('')
    const [categoryId, setCategoryId] = useState('')
    const [sortOrder, setSortOrder] = useState('0')
    const [featured, setFeatured] = useState(false)
    const [isActive, setIsActive] = useState(true)
    const [loading, setLoading] = useState(isEdit)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [loadedName, setLoadedName] = useState<string | null>(null)

    useEffect(() => {
        client.admin.catalogCategories
            .list({ domain: 'mcp' })
            .then(setCategories)
            .catch(() => {
                // best-effort — category select will just be empty
            })
    }, [client])

    useEffect(() => {
        if (!id) return
        setLoading(true)
        client.admin.mcpCatalog
            .get(id)
            .then((row) => {
                setLoadedName(row.name)
                setName(row.name)
                setSlug(row.slug)
                setDescription(row.description)
                setLongDescription(row.longDescription ?? '')
                setHomepageUrl(row.homepageUrl)
                setIconUrl(row.iconUrl ?? '')
                setTransport(row.transport)
                setUrl(row.url ?? '')
                setHeaders(pairsFromRecord(row.headers))
                setCommand(row.command ?? '')
                setArgs(row.args ?? [])
                setEnv(pairsFromRecord(row.env))
                setTagsText(row.tags.join(', '))
                setCategoryId(row.categoryId ?? '')
                setSortOrder(String(row.sortOrder))
                setFeatured(row.featured)
                setIsActive(row.isActive)
            })
            .catch((e: Error) => setError(e.message))
            .finally(() => setLoading(false))
    }, [client, id])

    const isHttp = transport === 'http'
    const canSubmit =
        !submitting &&
        name.trim().length > 0 &&
        slug.trim().length > 0 &&
        description.trim().length > 0 &&
        homepageUrl.trim().length > 0 &&
        (isHttp ? url.trim().length > 0 : command.trim().length > 0)

    const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
        e.preventDefault()
        setError(null)
        setSubmitting(true)
        const tags = [
            ...new Set(
                tagsText
                    .split(',')
                    .map((tag) => tag.trim())
                    .filter(Boolean)
            )
        ]
        const body: UpdateMcpCatalogEntryBody = {
            slug: slug.trim(),
            name: name.trim(),
            description: description.trim(),
            homepageUrl: homepageUrl.trim(),
            transport,
            url: isHttp ? url.trim() : null,
            headers: isHttp ? (recordFromPairs(headers) ?? null) : null,
            command: isHttp ? null : command.trim(),
            args: isHttp
                ? null
                : args.map((a) => a.trim()).filter(Boolean),
            env: isHttp ? null : (recordFromPairs(env) ?? null),
            longDescription: longDescription.trim() || null,
            iconUrl: iconUrl.trim() || null,
            tags,
            categoryId: categoryId || null,
            featured,
            sortOrder: Number.parseInt(sortOrder, 10) || 0,
            isActive
        }
        try {
            if (isEdit && id) {
                await client.admin.mcpCatalog.update(id, body)
            } else {
                await client.admin.mcpCatalog.create({
                    ...body,
                    slug: slug.trim(),
                    name: name.trim(),
                    description: description.trim(),
                    homepageUrl: homepageUrl.trim(),
                    transport,
                    url: isHttp ? url.trim() : undefined,
                    headers: isHttp ? recordFromPairs(headers) : undefined,
                    command: isHttp ? undefined : command.trim(),
                    args: isHttp
                        ? undefined
                        : args.map((a) => a.trim()).filter(Boolean),
                    env: isHttp ? undefined : recordFromPairs(env),
                    longDescription: longDescription.trim() || undefined,
                    iconUrl: iconUrl.trim() || undefined,
                    categoryId: categoryId || undefined
                })
            }
            navigate(adminRoutes.mcpCatalog)
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <DetailPage>
            <Breadcrumbs
                items={[
                    { label: 'MCP catalog', to: adminRoutes.mcpCatalog },
                    {
                        label: isEdit
                            ? (loadedName ?? 'Edit entry')
                            : 'New entry'
                    }
                ]}
            />
            <Heading level={2} className='mb-2'>
                {isEdit ? 'Edit MCP catalog entry' : 'New MCP catalog entry'}
            </Heading>

            <Card elevation='elevated'>
                <CardBody>
                    {loading ? (
                        <p className='text-caption text-body'>Loading…</p>
                    ) : (
                        <form onSubmit={submit} className='space-y-2'>
                            <Input
                                id='name'
                                label='Name'
                                placeholder='e.g. Context7'
                                required
                                maxLength={120}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />
                            <Input
                                id='slug'
                                label='Slug'
                                placeholder='e.g. context7'
                                hint='Public URL segment and MCP server key in agent configs. Lowercase letters, digits, - and _. Changing it changes the key new installs use.'
                                required
                                maxLength={64}
                                value={slug}
                                onChange={(e) => setSlug(e.target.value)}
                            />
                            <Input
                                id='description'
                                label='Description'
                                hint='One-liner shown on catalog cards.'
                                required
                                maxLength={1000}
                                value={description}
                                onChange={(e) =>
                                    setDescription(e.target.value)
                                }
                            />
                            <div>
                                <label
                                    htmlFor='longDescription'
                                    className='text-caption text-label mb-1 block font-normal'
                                >
                                    Long description (optional)
                                </label>
                                <textarea
                                    id='longDescription'
                                    className={textareaClass}
                                    rows={8}
                                    maxLength={50000}
                                    placeholder='Markdown, rendered as the About section on the public detail page.'
                                    value={longDescription}
                                    onChange={(e) =>
                                        setLongDescription(e.target.value)
                                    }
                                />
                            </div>
                            <Input
                                id='homepageUrl'
                                label='Homepage URL'
                                placeholder='https://…'
                                required
                                maxLength={1000}
                                value={homepageUrl}
                                onChange={(e) =>
                                    setHomepageUrl(e.target.value)
                                }
                            />
                            <Input
                                id='iconUrl'
                                label='Icon URL (optional)'
                                placeholder='https://…/icon.png'
                                maxLength={1000}
                                value={iconUrl}
                                onChange={(e) => setIconUrl(e.target.value)}
                            />

                            <div>
                                <label
                                    htmlFor='transport'
                                    className='text-caption text-label mb-1 block font-normal'
                                >
                                    Transport
                                </label>
                                <select
                                    id='transport'
                                    className={selectClass}
                                    value={transport}
                                    onChange={(e) =>
                                        setTransport(
                                            e.target
                                                .value as McpCatalogTransport
                                        )
                                    }
                                >
                                    <option value='http'>Remote (HTTP)</option>
                                    <option value='stdio'>
                                        Local (stdio)
                                    </option>
                                </select>
                            </div>

                            {isHttp ? (
                                <>
                                    <Input
                                        id='url'
                                        label='Server URL'
                                        placeholder='https://mcp.example.com/mcp'
                                        required
                                        maxLength={1000}
                                        value={url}
                                        onChange={(e) =>
                                            setUrl(e.target.value)
                                        }
                                    />
                                    <KeyValueRows
                                        label='Headers (optional)'
                                        hint='Values may contain ${PLACEHOLDER} markers users must fill after installing.'
                                        pairs={headers}
                                        onChange={setHeaders}
                                    />
                                </>
                            ) : (
                                <>
                                    <Input
                                        id='command'
                                        label='Command'
                                        placeholder='npx'
                                        required
                                        maxLength={255}
                                        value={command}
                                        onChange={(e) =>
                                            setCommand(e.target.value)
                                        }
                                    />
                                    <StringListRows
                                        label='Arguments'
                                        values={args}
                                        onChange={setArgs}
                                    />
                                    <KeyValueRows
                                        label='Environment (optional)'
                                        hint='Values may contain ${PLACEHOLDER} markers users must fill after installing.'
                                        pairs={env}
                                        onChange={setEnv}
                                    />
                                </>
                            )}

                            <div>
                                <label
                                    htmlFor='category'
                                    className='text-caption text-label mb-1 block font-normal'
                                >
                                    Category
                                </label>
                                <select
                                    id='category'
                                    className={selectClass}
                                    value={categoryId}
                                    onChange={(e) =>
                                        setCategoryId(e.target.value)
                                    }
                                >
                                    <option value=''>No category</option>
                                    {categories.map((category) => (
                                        <option
                                            key={category.id}
                                            value={category.id}
                                        >
                                            {category.name}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <Input
                                id='tags'
                                label='Tags'
                                placeholder='docs, libraries'
                                hint='Comma-separated.'
                                value={tagsText}
                                onChange={(e) => setTagsText(e.target.value)}
                            />
                            <Input
                                id='sortOrder'
                                label='Sort order'
                                type='number'
                                hint='Lower numbers list first within the featured ordering.'
                                value={sortOrder}
                                onChange={(e) => setSortOrder(e.target.value)}
                            />

                            <label className='text-caption text-label flex items-center gap-2'>
                                <input
                                    type='checkbox'
                                    checked={featured}
                                    onChange={(e) =>
                                        setFeatured(e.target.checked)
                                    }
                                />
                                Featured
                            </label>
                            <label className='text-caption text-label flex items-center gap-2'>
                                <input
                                    type='checkbox'
                                    checked={isActive}
                                    onChange={(e) =>
                                        setIsActive(e.target.checked)
                                    }
                                />
                                Active (listed in the public catalog)
                            </label>

                            {error && (
                                <div className='border-accent-ruby/30 bg-accent-ruby/5 rounded border px-3 py-2'>
                                    <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                                        {error}
                                    </pre>
                                </div>
                            )}

                            <Button
                                type='submit'
                                variant='primary'
                                size='md'
                                disabled={!canSubmit}
                                className='w-full'
                            >
                                {submitting
                                    ? 'Saving…'
                                    : isEdit
                                      ? 'Save changes'
                                      : 'Create entry'}
                            </Button>
                        </form>
                    )}
                </CardBody>
            </Card>
        </DetailPage>
    )
}

export default McpCatalogForm