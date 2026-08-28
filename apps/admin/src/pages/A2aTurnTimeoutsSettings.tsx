import type { A2aTurnTimeoutsSettings } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { Button, Card, Heading, Input } from '@/ui'

type Draft = A2aTurnTimeoutsSettings

const A2aTurnTimeoutsSettingsPage: FC<{ embedded?: boolean }> = ({
    embedded = false
}): ReactNode => {
    const client = useApiClient()
    const [draft, setDraft] = useState<Draft | null>(null)
    const [loaded, setLoaded] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [status, setStatus] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const load = useCallback((): void => {
        setError(null)
        client.admin.settings
            .getA2aTurnTimeouts()
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
            const settings = await client.admin.settings.updateA2aTurnTimeouts(
                {
                    blockingTimeoutSeconds: draft.blockingTimeoutSeconds,
                    asyncTimeoutSeconds: draft.asyncTimeoutSeconds
                }
            )
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
                    A2A turn timeouts
                </Heading>
                <p className='admin-page-description'>
                    Server-side caps on delegated agent-to-agent turns. Blocking
                    sends hold the caller&apos;s request open, so they get the
                    short cap; async sends (blocking:false / mf a2a send
                    --async) are polled later via tasks/get and get the longer
                    cap. Past its cap a task fails with turn_timeout and the
                    target turn is cancelled.
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
                            id='blocking-timeout-seconds'
                            label='Blocking turn cap (seconds)'
                            type='number'
                            min={30}
                            value={String(draft.blockingTimeoutSeconds)}
                            onChange={(e) =>
                                setDraft({
                                    ...draft,
                                    blockingTimeoutSeconds: Number(
                                        e.target.value
                                    )
                                })
                            }
                        />
                        <Input
                            id='async-timeout-seconds'
                            label='Async turn cap (seconds)'
                            type='number'
                            min={30}
                            hint='Must be at least the blocking cap; async tasks keep running detached and are polled via tasks/get.'
                            value={String(draft.asyncTimeoutSeconds)}
                            onChange={(e) =>
                                setDraft({
                                    ...draft,
                                    asyncTimeoutSeconds: Number(e.target.value)
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
                </Card>
            )}
        </section>
    )
}

export default A2aTurnTimeoutsSettingsPage
