import type {
    ConfigurableFrameworkRuntimeDefault,
    FrameworkRuntimeChoice,
    SdkUserSummary
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { Button, Card, CardBody, Heading } from '@/ui'

type EditableFramework = ConfigurableFrameworkRuntimeDefault

const EDITABLE_FRAMEWORKS: { key: EditableFramework; label: string }[] = [
    { key: 'hermes', label: 'Hermes Agent' },
    { key: 'openclaw', label: 'OpenClaw' }
]

const RUNTIME_OPTIONS: {
    value: '' | FrameworkRuntimeChoice
    label: string
}[] = [
    { value: '', label: 'Use admin default' },
    { value: 'sprites', label: 'Sprites (override)' },
    { value: 'k8s', label: 'K8s (override)' }
]

interface Props {
    userId: string
    onUserUpdated?: (user: SdkUserSummary) => void
}

const UserFrameworkRuntimeOverridesCard: FC<Props> = ({
    userId,
    onUserUpdated
}: Props): ReactNode => {
    const client = useApiClient()
    const [draft, setDraft] = useState<
        Partial<Record<EditableFramework, FrameworkRuntimeChoice | ''>>
    >({})
    const [loaded, setLoaded] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [status, setStatus] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const load = useCallback((): void => {
        setError(null)
        client.admin.users
            .getFrameworkRuntimeOverrides(userId)
            .then((settings) => {
                const next: Partial<
                    Record<EditableFramework, FrameworkRuntimeChoice | ''>
                > = {}
                for (const { key } of EDITABLE_FRAMEWORKS) {
                    next[key] = settings.overrides[key] ?? ''
                }
                setDraft(next)
                setLoaded(true)
            })
            .catch((err: Error) => setError(err.message))
    }, [client, userId])

    useEffect(load, [load])

    const save = async (): Promise<void> => {
        setBusy(true)
        setError(null)
        setStatus(null)
        const overrides: Partial<
            Record<EditableFramework, FrameworkRuntimeChoice>
        > = {}
        for (const { key } of EDITABLE_FRAMEWORKS) {
            const v = draft[key]
            if (v === 'sprites' || v === 'k8s') overrides[key] = v
        }
        try {
            const updated =
                await client.admin.users.setFrameworkRuntimeOverrides(userId, {
                    overrides
                })
            onUserUpdated?.(updated)
            setStatus('Saved')
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <Card elevation='ambient' className='overflow-hidden'>
            <CardBody className='p-0'>
                <div className='border-border flex flex-wrap items-center justify-between gap-2 border-b px-2 py-1.5'>
                    <Heading level={3}>Framework runtime overrides</Heading>
                </div>
                <div className='space-y-2 p-2'>
                    <p className='text-caption-sm text-body-muted'>
                        Per-user override of the admin default runtime per
                        framework. Takes priority over the global setting for
                        this user only. Leave blank to inherit the admin
                        default.
                    </p>

                    {error && (
                        <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                            {error}
                        </pre>
                    )}

                    {!loaded && !error && (
                        <p className='text-caption text-body'>Loading…</p>
                    )}

                    {loaded && (
                        <>
                            {EDITABLE_FRAMEWORKS.map(({ key, label }) => (
                                <div
                                    key={key}
                                    className='flex items-center gap-3'
                                >
                                    <label
                                        htmlFor={`fwoverride-${key}`}
                                        className='text-body min-w-[120px]'
                                    >
                                        {label}
                                    </label>
                                    <select
                                        id={`fwoverride-${key}`}
                                        className='border-divider bg-canvas text-body flex-1 rounded border px-2 py-1'
                                        value={draft[key] ?? ''}
                                        onChange={(e) =>
                                            setDraft((d) => ({
                                                ...d,
                                                [key]: e.target.value as
                                                    | ''
                                                    | FrameworkRuntimeChoice
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
                            <div className='mt-2 flex items-center justify-end gap-2'>
                                {status && (
                                    <span className='text-caption-sm text-brand'>
                                        {status}
                                    </span>
                                )}
                                <Button
                                    variant='ghost'
                                    size='sm'
                                    onClick={load}
                                    disabled={busy}
                                >
                                    Reset
                                </Button>
                                <Button
                                    variant='primary'
                                    size='sm'
                                    onClick={() => void save()}
                                    disabled={busy}
                                >
                                    Save overrides
                                </Button>
                            </div>
                        </>
                    )}
                </div>
            </CardBody>
        </Card>
    )
}

export default UserFrameworkRuntimeOverridesCard
