import type { Plan, SdkUserSummary } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { Button, Card, CardBody, Heading } from '@/ui'

interface Props {
    userId: string
    planId: string
    onUserUpdated?: (user: SdkUserSummary) => void
}

const describe = (plan: Plan): string =>
    `${plan.name} — ${plan.maxAgentsProvisioned} provisioned, ${plan.maxConcurrentActive} concurrent, ${plan.maxStorageGb} GB`

// There is no Select primitive in src/ui; mirror Input.tsx's class string so
// this control matches every other field in the admin.
const selectClass =
    'block w-full h-8 rounded border border-border bg-white px-2 text-caption text-heading transition-colors focus:outline-none focus:border-brand focus:ring-1 focus:ring-brand'

const UserPlanCard: FC<Props> = ({
    userId,
    planId,
    onUserUpdated
}: Props): ReactNode => {
    const client = useApiClient()
    const [plans, setPlans] = useState<Plan[] | null>(null)
    const [draft, setDraft] = useState(planId)
    const [error, setError] = useState<string | null>(null)
    const [status, setStatus] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const load = useCallback((): void => {
        setError(null)
        client.admin.plans
            .list()
            .then(setPlans)
            .catch((err: Error) => setError(err.message))
    }, [client])

    useEffect(load, [load])
    useEffect(() => setDraft(planId), [planId])

    const save = async (): Promise<void> => {
        setBusy(true)
        setError(null)
        setStatus(null)
        try {
            const updated = await client.admin.users.setPlan(userId, draft)
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
                    <Heading level={3}>Plan</Heading>
                </div>
                <div className='space-y-2 p-2'>
                    <p className='text-caption-sm text-body'>
                        Every quota this account gets comes from its plan. New
                        accounts land on{' '}
                        <span className='font-mono'>MF_DEFAULT_PLAN_ID</span>,
                        which only applies when the account is created — use
                        this to move an account that was created before the
                        deployment set it.
                    </p>

                    {error && (
                        <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                            {error}
                        </pre>
                    )}

                    {!plans && !error && (
                        <p className='text-caption text-body'>Loading…</p>
                    )}

                    {plans && (
                        <>
                            <div>
                                <label
                                    htmlFor='userPlan'
                                    className='text-caption text-label mb-1 block font-normal'
                                >
                                    Assigned plan
                                </label>
                                <select
                                    id='userPlan'
                                    className={selectClass}
                                    value={draft}
                                    onChange={(e) => setDraft(e.target.value)}
                                >
                                    {plans.map((plan) => (
                                        <option key={plan.id} value={plan.id}>
                                            {describe(plan)}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className='mt-2 flex items-center justify-end gap-2'>
                                {status && (
                                    <span className='text-caption-sm text-brand'>
                                        {status}
                                    </span>
                                )}
                                <Button
                                    variant='ghost'
                                    size='sm'
                                    onClick={() => setDraft(planId)}
                                    disabled={busy || draft === planId}
                                >
                                    Reset
                                </Button>
                                <Button
                                    variant='primary'
                                    size='sm'
                                    onClick={() => void save()}
                                    disabled={busy || draft === planId}
                                >
                                    Save plan
                                </Button>
                            </div>
                        </>
                    )}
                </div>
            </CardBody>
        </Card>
    )
}

export default UserPlanCard
