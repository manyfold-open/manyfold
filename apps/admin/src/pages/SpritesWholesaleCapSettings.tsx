import type {
    SpritesVendorCapacityView,
    SpritesWholesaleCapSettings
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { Badge, Button, Card, Heading, Input } from '@/ui'

type Draft = SpritesWholesaleCapSettings

const observedAgo = (iso: string): string => {
    const ms = Date.now() - new Date(iso).getTime()
    if (!Number.isFinite(ms) || ms < 0) return iso
    const min = Math.round(ms / 60_000)
    if (min < 1) return 'just now'
    if (min < 60) return `${min}m ago`
    const hr = Math.round(min / 60)
    if (hr < 48) return `${hr}h ago`
    return `${Math.round(hr / 24)}d ago`
}

const limit = (value: number | null): string =>
    value === null ? '—' : String(value)

const VendorCapacityPanel: FC<{ vendor: SpritesVendorCapacityView | null }> = ({
    vendor
}): ReactNode => {
    if (!vendor) return null
    return (
        <Card elevation='flat' className='border-border mt-2 p-2'>
            <div className='mb-1 flex items-center justify-between'>
                <span className='text-caption text-label'>
                    Reported by sprites.dev
                </span>
                {vendor.clamped && <Badge tone='warning'>Clamped</Badge>}
            </div>
            {vendor.accounts.length === 0 ? (
                <p className='text-caption-sm text-body'>
                    No observation yet — the sprite status-sync loop records
                    each account&apos;s running/warm limits on its next pass.
                    Until then admission uses the policy cap above.
                </p>
            ) : (
                <table className='w-full'>
                    <thead>
                        <tr className='text-caption-sm text-body text-left uppercase'>
                            <th className='py-1 font-normal'>Account</th>
                            <th className='py-1 font-normal'>Running</th>
                            <th className='py-1 font-normal'>Warm</th>
                            <th className='py-1 font-normal'>Cold</th>
                            <th className='py-1 font-normal'>Observed</th>
                        </tr>
                    </thead>
                    <tbody>
                        {vendor.accounts.map((account) => (
                            <tr
                                key={account.accountId}
                                className='border-border text-caption text-heading border-t'
                            >
                                <td className='py-1.5'>{account.slug}</td>
                                <td className='py-1.5 font-mono'>
                                    {account.running} /{' '}
                                    {limit(account.runningLimit)}
                                </td>
                                <td className='py-1.5 font-mono'>
                                    {account.warm} / {limit(account.warmLimit)}
                                </td>
                                <td className='py-1.5 font-mono'>
                                    {account.cold}
                                </td>
                                <td className='text-body py-1.5'>
                                    {observedAgo(account.observedAt)}{' '}
                                    {account.stale && (
                                        <Badge tone='neutral'>stale</Badge>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {vendor.clamped && (
                <p className='text-caption-sm text-accent-lemon mt-2'>
                    Policy active cap is {vendor.policyActiveCap} but sprites.dev
                    will only serve {limit(vendor.runningLimitTotal)} concurrent
                    running sprites. Admission enforces{' '}
                    {vendor.effectiveActiveCap}. Raise the sprites.dev
                    subscription, or lower the policy cap so it stops promising
                    capacity the vendor refuses.
                </p>
            )}
            {vendor.warmLimitTotal !== null &&
                vendor.warmTotal >= vendor.warmLimitTotal && (
                    <p className='text-caption-sm text-accent-lemon mt-2'>
                        Warm sprites are at the vendor warm limit (
                        {vendor.warmTotal} / {vendor.warmLimitTotal}). Nothing
                        blocks on this today — new sprites may start failing at
                        sprites.dev instead.
                    </p>
                )}
        </Card>
    )
}

interface SpritesWholesaleCapSettingsPageProps {
    embedded?: boolean
    onSaved?: () => void
}

const SpritesWholesaleCapSettingsPage: FC<
    SpritesWholesaleCapSettingsPageProps
> = ({ embedded = false, onSaved }): ReactNode => {
    const client = useApiClient()
    const [draft, setDraft] = useState<Draft | null>(null)
    const [vendor, setVendor] = useState<SpritesVendorCapacityView | null>(null)
    const [loaded, setLoaded] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [status, setStatus] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const loadVendor = useCallback((): void => {
        // Read-only context panel: a failure here must not block editing policy.
        client.admin.settings
            .getSpritesVendorCapacity()
            .then(setVendor)
            .catch(() => setVendor(null))
    }, [client])

    const load = useCallback((): void => {
        setError(null)
        loadVendor()
        client.admin.settings
            .getSpritesWholesaleCap()
            .then((settings) => {
                setDraft(settings)
                setLoaded(true)
            })
            .catch((err: Error) => setError(err.message))
    }, [client, loadVendor])

    useEffect(load, [load])

    const save = async (): Promise<void> => {
        if (!draft) return
        setBusy(true)
        setError(null)
        setStatus(null)
        try {
            const settings =
                await client.admin.settings.updateSpritesWholesaleCap({
                    activeCap: draft.activeCap,
                    softThresholdPct: draft.softThresholdPct
                })
            setDraft(settings)
            setStatus('Saved')
            loadVendor()
            onSaved?.()
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
                    {embedded ? 'Capacity policy' : 'Sprites wholesale cap'}
                </Heading>
                <p className='admin-page-description'>
                    Org-wide ceiling on concurrent active sprites. Reaching the
                    soft threshold emits a telemetry warning; reaching the
                    active cap blocks new sprite wakes with HTTP 503 and a 30 s
                    Retry-After header. This is a policy ceiling — sprites.dev
                    reports its own limits (below) and admission enforces
                    whichever is lower, so setting this above the vendor limit
                    grants nothing.
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
                            id='active-cap'
                            label='Active cap'
                            type='number'
                            min={1}
                            value={String(draft.activeCap)}
                            onChange={(e) =>
                                setDraft({
                                    ...draft,
                                    activeCap: Number(e.target.value)
                                })
                            }
                        />
                        <Input
                            id='soft-threshold-pct'
                            label='Soft threshold (%)'
                            type='number'
                            min={1}
                            max={99}
                            value={String(draft.softThresholdPct)}
                            onChange={(e) =>
                                setDraft({
                                    ...draft,
                                    softThresholdPct: Number(e.target.value)
                                })
                            }
                        />
                    </div>
                    <VendorCapacityPanel vendor={vendor} />
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

export default SpritesWholesaleCapSettingsPage
