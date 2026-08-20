import type { BuiltinSkillRepoEntry } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { Button, Card, Heading, Input } from '@/ui'

type DraftRow = BuiltinSkillRepoEntry

const SkillReposSettingsPage: FC = (): ReactNode => {
    const client = useApiClient()
    const [rows, setRows] = useState<DraftRow[]>([])
    const [loaded, setLoaded] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [status, setStatus] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const load = useCallback((): void => {
        setError(null)
        client.admin.settings
            .getBuiltinSkillRepos()
            .then((settings) => {
                setRows(settings.repos)
                setLoaded(true)
            })
            .catch((err: Error) => setError(err.message))
    }, [client])

    useEffect(load, [load])

    const updateRow = (index: number, patch: Partial<DraftRow>): void => {
        setRows((current) =>
            current.map((row, i) => (i === index ? { ...row, ...patch } : row))
        )
    }

    const removeRow = (index: number): void => {
        setRows((current) => current.filter((_, i) => i !== index))
    }

    const addRow = (): void => {
        setRows((current) => [
            ...current,
            { owner: '', name: '', branch: 'main', enabled: true }
        ])
    }

    const save = async (): Promise<void> => {
        setBusy(true)
        setError(null)
        setStatus(null)
        try {
            const settings = await client.admin.settings.updateBuiltinSkillRepos(
                {
                    repos: rows.map((row) => ({
                        owner: row.owner.trim(),
                        name: row.name.trim(),
                        branch: row.branch.trim() || 'main',
                        enabled: row.enabled
                    }))
                }
            )
            setRows(settings.repos)
            setStatus('Saved')
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className='mx-auto max-w-3xl'>
            <div className='mb-3'>
                <Heading level={2} className='mb-2'>
                    Built-in skill repos
                </Heading>
                <p className='admin-page-description'>
                    GitHub repositories surfaced to every user as built-in skill
                    sources. Entries are read-only on the user side; toggle{' '}
                    <span className='font-mono'>Enabled</span> off to hide one
                    without deleting it.
                </p>
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

            {!loaded && !error && (
                <p className='text-caption text-body'>Loading…</p>
            )}

            {loaded && (
                <Card elevation='ambient' className='p-3'>
                    {rows.length === 0 ? (
                        <p className='text-caption text-body mb-3'>
                            No built-in skill repos configured. Users will see
                            an empty discovery list until you add at least one.
                        </p>
                    ) : (
                        <div className='space-y-2'>
                            {rows.map((row, index) => (
                                <div
                                    key={index}
                                    className='border-border grid items-end gap-2 rounded border p-2 md:grid-cols-[1fr_1fr_1fr_auto_auto]'
                                >
                                    <Input
                                        id={`repo-${index}-owner`}
                                        label='Owner'
                                        value={row.owner}
                                        onChange={(e) =>
                                            updateRow(index, {
                                                owner: e.target.value
                                            })
                                        }
                                    />
                                    <Input
                                        id={`repo-${index}-name`}
                                        label='Repo'
                                        value={row.name}
                                        onChange={(e) =>
                                            updateRow(index, {
                                                name: e.target.value
                                            })
                                        }
                                    />
                                    <Input
                                        id={`repo-${index}-branch`}
                                        label='Branch'
                                        value={row.branch}
                                        onChange={(e) =>
                                            updateRow(index, {
                                                branch: e.target.value
                                            })
                                        }
                                    />
                                    <label className='text-caption text-body flex h-8 items-center gap-2 self-end'>
                                        <input
                                            type='checkbox'
                                            checked={row.enabled}
                                            onChange={(e) =>
                                                updateRow(index, {
                                                    enabled: e.target.checked
                                                })
                                            }
                                        />
                                        Enabled
                                    </label>
                                    <Button
                                        variant='ghost'
                                        size='sm'
                                        onClick={() => removeRow(index)}
                                        disabled={busy}
                                    >
                                        Remove
                                    </Button>
                                </div>
                            ))}
                        </div>
                    )}

                    <div className='mt-3 flex items-center justify-between gap-2'>
                        <Button
                            variant='ghost'
                            onClick={addRow}
                            disabled={busy}
                        >
                            Add repo
                        </Button>
                        <div className='flex items-center gap-2'>
                            {status && (
                                <span className='text-caption-sm text-brand'>
                                    {status}
                                </span>
                            )}
                            <Button
                                variant='ghost'
                                onClick={load}
                                disabled={busy}
                            >
                                Reset
                            </Button>
                            <Button
                                variant='primary'
                                disabled={busy}
                                onClick={() => void save()}
                            >
                                Save
                            </Button>
                        </div>
                    </div>
                </Card>
            )}
        </div>
    )
}

export default SkillReposSettingsPage
