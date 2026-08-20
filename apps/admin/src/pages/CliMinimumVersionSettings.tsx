import type { CliMinimumVersionSettings } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { Button, Card, Heading, Input } from '@/ui'

const CliMinimumVersionSettingsPage: FC = (): ReactNode => {
    const client = useApiClient()
    const [draft, setDraft] = useState<string>('')
    const [loaded, setLoaded] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [status, setStatus] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const applySettings = (settings: CliMinimumVersionSettings): void => {
        setDraft(settings.minVersion ?? '')
    }

    const load = useCallback((): void => {
        setError(null)
        client.admin.settings
            .getCliMinimumVersion()
            .then((settings) => {
                applySettings(settings)
                setLoaded(true)
            })
            .catch((err: Error) => setError(err.message))
    }, [client])

    useEffect(load, [load])

    const save = async (): Promise<void> => {
        setBusy(true)
        setError(null)
        setStatus(null)
        const trimmed = draft.trim()
        const minVersion = trimmed.length > 0 ? trimmed : null
        try {
            const settings =
                await client.admin.settings.updateCliMinimumVersion({
                    minVersion
                })
            applySettings(settings)
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
                    CLI minimum version
                </Heading>
                <p className='admin-page-description'>
                    Set the minimum mf CLI version required for connected local
                    daemons. Users running older versions are blocked from
                    sending chat messages to daemon-backed agents and shown an
                    upgrade prompt in the web app. Leave blank to disable the
                    gate.
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
                    <div className='space-y-2'>
                        <Input
                            id='cli-min-version'
                            label='Minimum mf CLI version (semver, blank to disable)'
                            placeholder='e.g. 0.42.0'
                            hint='Format: major.minor.patch with optional leading v. Blank disables the gate.'
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
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
        </div>
    )
}

export default CliMinimumVersionSettingsPage
