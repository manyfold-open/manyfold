import type { ChatExecTimeoutsSettings } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { Button, Card, Heading, Input } from '@/ui'

type Draft = ChatExecTimeoutsSettings

const ChatExecTimeoutsSettingsPage: FC<{ embedded?: boolean }> = ({
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
            .getChatExecTimeouts()
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
                await client.admin.settings.updateChatExecTimeouts({
                    keepAliveSeconds: draft.keepAliveSeconds,
                    livenessTimeoutSeconds: draft.livenessTimeoutSeconds,
                    maxTimeoutSeconds: draft.maxTimeoutSeconds
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
                    Chat exec timeouts
                </Heading>
                <p className='admin-page-description'>
                    Liveness controls for streaming agent turns (Claude Code,
                    Codex, Gemini on sprites). The server pings the sprite every
                    keep-alive interval; if no frame or pong arrives within the
                    liveness window the turn fails fast as a lost connection. The
                    max duration is an absolute backstop — set it to 0 for no cap
                    (rely on liveness and user cancel), which lets long
                    autonomous runs continue for hours.
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
                            id='keepalive-seconds'
                            label='Keep-alive ping interval (seconds)'
                            type='number'
                            min={1}
                            value={String(draft.keepAliveSeconds)}
                            onChange={(e) =>
                                setDraft({
                                    ...draft,
                                    keepAliveSeconds: Number(e.target.value)
                                })
                            }
                        />
                        <Input
                            id='liveness-seconds'
                            label='Liveness timeout (seconds)'
                            type='number'
                            min={1}
                            hint='Must be greater than the keep-alive interval.'
                            value={String(draft.livenessTimeoutSeconds)}
                            onChange={(e) =>
                                setDraft({
                                    ...draft,
                                    livenessTimeoutSeconds: Number(
                                        e.target.value
                                    )
                                })
                            }
                        />
                        <Input
                            id='max-seconds'
                            label='Max turn duration (seconds, 0 = unlimited)'
                            type='number'
                            min={0}
                            value={String(draft.maxTimeoutSeconds)}
                            onChange={(e) =>
                                setDraft({
                                    ...draft,
                                    maxTimeoutSeconds: Number(e.target.value)
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

export default ChatExecTimeoutsSettingsPage
