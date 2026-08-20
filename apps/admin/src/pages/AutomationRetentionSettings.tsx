import { DEFAULT_AUTOMATION_RETENTION_DAYS } from '@manyfold/shared'
import type { AutomationRetentionSettings } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { Button, Card, Heading, Input } from '@/ui'

const AutomationRetentionSettingsPage: FC<{ embedded?: boolean }> = ({
    embedded = false
}): ReactNode => {
    const client = useApiClient()
    const [draft, setDraft] = useState<AutomationRetentionSettings | null>(null)
    const [loaded, setLoaded] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [status, setStatus] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const load = useCallback((): void => {
        setError(null)
        client.admin.settings
            .getAutomationRetention()
            .then((settings) => {
                setDraft(settings)
                setLoaded(true)
            })
            .catch((err: Error) => setError(err.message))
    }, [client])

    useEffect(load, [load])

    const save = async (): Promise<void> => {
        if (!draft) return
        setBusy(true)
        setError(null)
        setStatus(null)
        try {
            const settings =
                await client.admin.settings.updateAutomationRetention({
                    retentionDays: draft.retentionDays
                })
            setDraft(settings)
            setStatus('Saved')
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <section className={embedded ? undefined : 'mx-auto max-w-3xl'}>
            <div className='mb-3'>
                <Heading level={embedded ? 3 : 2} className='mb-2'>
                    Automation retention
                </Heading>
                <p className='admin-page-description'>
                    Deleting an automation hides it immediately but keeps the
                    tombstoned record and its run history in the database for
                    this many days before the background sweep hard-deletes
                    them. The current value applies on the next sweep, including
                    to automations deleted under a previous value. Default:{' '}
                    {DEFAULT_AUTOMATION_RETENTION_DAYS} days.
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

            {loaded && draft && (
                <Card elevation='ambient' className='p-3'>
                    <div className='space-y-2'>
                        <Input
                            id='automation-retention-days'
                            label='Retention window (days)'
                            type='number'
                            min={1}
                            hint='Positive whole number of days a deleted automation and its runs remain recoverable in PostgreSQL.'
                            value={String(draft.retentionDays)}
                            onChange={(e) =>
                                setDraft({
                                    retentionDays: Number(e.target.value)
                                })
                            }
                        />
                    </div>
                    <div className='mt-3 flex items-center justify-end gap-2'>
                        {status && (
                            <span className='text-caption-sm text-brand'>
                                {status}
                            </span>
                        )}
                        <Button variant='ghost' onClick={load} disabled={busy}>
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
                </Card>
            )}
        </section>
    )
}

export default AutomationRetentionSettingsPage
