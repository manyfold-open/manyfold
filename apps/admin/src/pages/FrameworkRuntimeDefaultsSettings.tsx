import type {
    ConfigurableFrameworkRuntimeDefault,
    FrameworkRuntimeChoice,
    FrameworkRuntimeDefaultsSettings
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { Button, Card, Heading } from '@/ui'

type EditableFramework = ConfigurableFrameworkRuntimeDefault

const EDITABLE_FRAMEWORKS: { key: EditableFramework; label: string }[] = [
    { key: 'hermes', label: 'Hermes Agent' },
    { key: 'openclaw', label: 'OpenClaw' }
]

const RUNTIME_OPTIONS: {
    value: FrameworkRuntimeChoice
    label: string
}[] = [
    {
        value: 'sprites',
        label: 'Sprites — Firecracker VM, per-agent isolation'
    },
    { value: 'k8s', label: 'K8s — shared cluster, central gateway' }
]

const FrameworkRuntimeDefaultsSettingsPage: FC = (): ReactNode => {
    const client = useApiClient()
    const [draft, setDraft] = useState<
        Record<EditableFramework, FrameworkRuntimeChoice>
    >({
        hermes: 'sprites',
        openclaw: 'sprites'
    })
    const [loaded, setLoaded] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [status, setStatus] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const applySettings = (
        settings: FrameworkRuntimeDefaultsSettings
    ): void => {
        setDraft({
            hermes: settings.defaults.hermes,
            openclaw: settings.defaults.openclaw
        })
    }

    const load = useCallback((): void => {
        setError(null)
        client.admin.settings
            .getFrameworkRuntimeDefaults()
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
        try {
            const settings =
                await client.admin.settings.updateFrameworkRuntimeDefaults({
                    defaults: draft
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
                    Framework runtime defaults
                </Heading>
                <p className='admin-page-description'>
                    Choose which runtime new agents should land on when the
                    caller does not specify one. This page currently exposes the
                    configurable defaults for Hermes and OpenClaw; Claude Code /
                    Codex / Gemini CLI default to sprites, Dify / Langflow
                    always use external, and NarraNexus supports sprites or K8s
                    from the create flow.
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
                        {EDITABLE_FRAMEWORKS.map(({ key, label }) => (
                            <div key={key} className='flex items-center gap-3'>
                                <label
                                    htmlFor={`fwdefault-${key}`}
                                    className='text-body min-w-[140px]'
                                >
                                    {label}
                                </label>
                                <select
                                    id={`fwdefault-${key}`}
                                    className='border-divider bg-canvas text-body flex-1 rounded border px-2 py-1'
                                    value={draft[key] ?? ''}
                                    onChange={(e) =>
                                        setDraft((d) => ({
                                            ...d,
                                            [key]: e.target
                                                .value as FrameworkRuntimeChoice
                                        }))
                                    }
                                >
                                    {RUNTIME_OPTIONS.map((opt) => (
                                        <option
                                            key={opt.value}
                                            value={opt.value}
                                        >
                                            {opt.label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        ))}
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
        </div>
    )
}

export default FrameworkRuntimeDefaultsSettingsPage
