import type { FeatureToggleView } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { Card, Heading } from '@/ui'

const FeatureTogglesSettingsPage: FC = (): ReactNode => {
    const client = useApiClient()
    const [toggles, setToggles] = useState<FeatureToggleView[] | null>(null)
    const [loaded, setLoaded] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [status, setStatus] = useState<string | null>(null)
    const [busyKey, setBusyKey] = useState<string | null>(null)

    const load = useCallback((): void => {
        setError(null)
        client.admin.settings
            .getFeatureToggles()
            .then((view) => {
                setToggles(view.toggles)
                setLoaded(true)
            })
            .catch((err: Error) => setError(err.message))
    }, [client])

    useEffect(load, [load])

    const setEnabled = async (
        toggle: FeatureToggleView,
        enabled: boolean
    ): Promise<void> => {
        setBusyKey(toggle.key)
        setError(null)
        setStatus(null)
        try {
            const view = await client.admin.settings.updateFeatureToggle({
                key: toggle.key,
                enabled
            })
            setToggles(view.toggles)
            setStatus(`${toggle.label} ${enabled ? 'enabled' : 'disabled'}`)
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusyKey(null)
        }
    }

    return (
        <div className='mx-auto max-w-3xl'>
            <div className='mb-3'>
                <Heading level={2} className='mb-2'>
                    Feature toggles
                </Heading>
                <p className='admin-page-description'>
                    Global on/off switches for platform features. Each
                    environment (prod, staging, local) has its own database and
                    is configured independently here. A feature defaults to off
                    until you turn it on.
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

            {loaded && toggles && (
                <Card elevation='ambient' className='p-3'>
                    <div className='divide-border divide-y'>
                        {toggles.map((toggle) => (
                            <div
                                key={toggle.key}
                                className='flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0'
                            >
                                <div className='min-w-0'>
                                    <div className='text-body flex flex-wrap items-center gap-2 font-medium'>
                                        {toggle.label}
                                        {!toggle.overridden && (
                                            <span className='text-caption-sm text-body font-normal'>
                                                default (
                                                {toggle.defaultEnabled
                                                    ? 'on'
                                                    : 'off'}
                                                )
                                            </span>
                                        )}
                                    </div>
                                    <p className='text-caption-sm text-body mt-1'>
                                        {toggle.description}
                                    </p>
                                </div>
                                <label className='text-caption text-label flex shrink-0 items-center gap-2 font-normal'>
                                    <input
                                        type='checkbox'
                                        checked={toggle.enabled}
                                        disabled={busyKey === toggle.key}
                                        onChange={(e) =>
                                            void setEnabled(
                                                toggle,
                                                e.target.checked
                                            )
                                        }
                                        className='accent-brand'
                                    />
                                    {toggle.enabled ? 'On' : 'Off'}
                                </label>
                            </div>
                        ))}
                    </div>
                    {status && (
                        <div className='mt-3 flex justify-end'>
                            <span className='text-caption-sm text-brand'>
                                {status}
                            </span>
                        </div>
                    )}
                </Card>
            )}
        </div>
    )
}

export default FeatureTogglesSettingsPage
