import type {
    RuntimeAccessSummary,
    SdkUserSummary,
    UsageSummary,
    UserRole
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { t } from '@manyfold/i18n'
import { useApiClient } from '@/lib/apiClient'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { adminRoutes } from '@/routes'
import {
    Badge,
    Breadcrumbs,
    Button,
    Card,
    CardBody,
    DetailPage,
    Heading,
    Input
} from '@/ui'
import {
    formatCost,
    formatDateTime,
    formatNumber,
    roleTone
} from './userFormatters'
import UserContainersSection from './UserContainersSection'
import UserFrameworkRuntimeOverridesCard from '@/components/UserFrameworkRuntimeOverridesCard'
import { DetailRow } from '@/pages/Users/DetailRow'
import UserCommerceSection from '@/pages/Users/UserCommerceSection'
import PlanCommerceRows, { ManagedSpendRows } from '@/pages/Users/PlanCommerceRows'

interface AccessDraft {
    statefulSandboxLimit: number
    alwaysOnlineRuntimeBonus: number
    activeHoursBonus: number
}

const nonNegativeInt = (value: number): number => {
    if (!Number.isFinite(value)) return 0
    return Math.max(0, Math.trunc(value))
}

const formatGb = (bytes: number): string =>
    `${(bytes / 1_000_000_000).toFixed(2)} GB`

const formatLimit = (value: number | null): string =>
    value === null ? '∞' : formatNumber(value)


const toAccessDraft = (user: SdkUserSummary): AccessDraft => ({
    statefulSandboxLimit: user.statefulSandboxLimit,
    alwaysOnlineRuntimeBonus: user.alwaysOnlineRuntimeBonus,
    activeHoursBonus: user.activeHoursBonus
})


const UserDetail: FC = (): ReactNode => {
    const { id } = useParams<{ id: string }>()
    const client = useApiClient()
    const { user: currentUser } = useCurrentUser()
    const [user, setUser] = useState<SdkUserSummary | null>(null)
    const [accessDraft, setAccessDraft] = useState<AccessDraft | null>(null)
    const [planUsage, setPlanUsage] = useState<RuntimeAccessSummary | null>(null)
    const [modelSpend, setModelSpend] = useState<UsageSummary | null>(null)
    const [planUsageError, setPlanUsageError] = useState<string | null>(null)
    const [loadingUser, setLoadingUser] = useState(true)
    const [notFound, setNotFound] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [busyId, setBusyId] = useState<string | null>(null)

    const refreshUser = useCallback(async (): Promise<void> => {
        if (!id) return
        setLoadingUser(true)
        setNotFound(false)
        setError(null)
        try {
            const rows = await client.admin.users.list()
            const found = rows.find((row) => row.id === id) ?? null
            setUser(found)
            setAccessDraft(found ? toAccessDraft(found) : null)
            setNotFound(found === null)
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setLoadingUser(false)
        }
    }, [client, id])

    const refreshPlanUsage = useCallback(async (): Promise<void> => {
        if (!id) return
        setPlanUsageError(null)
        // The access summary carries the user's billing-period window; model
        // spend is scoped to the same window so the two cards agree. Calendar
        // month is only the fallback when the summary call itself failed.
        let periodStart: string | null = null
        try {
            const access = await client.admin.users.getRuntimeAccess(id)
            setPlanUsage(access)
            periodStart = access.usagePeriod.start
        } catch (e) {
            setPlanUsageError((e as Error).message)
        }
        const from =
            periodStart ??
            new Date(
                Date.UTC(
                    new Date().getUTCFullYear(),
                    new Date().getUTCMonth(),
                    1
                )
            ).toISOString()
        const [spend] = await Promise.allSettled([
            client.admin.usage.summary({ userId: id, from })
        ])
        if (spend.status === 'fulfilled') setModelSpend(spend.value)
    }, [client, id])

    useEffect(() => {
        void refreshUser()
        void refreshPlanUsage()
    }, [refreshPlanUsage, refreshUser])

    const setRole = async (role: UserRole): Promise<void> => {
        if (!user) return
        setBusyId('role')
        setError(null)
        try {
            const updated = await client.admin.users.setRole(user.id, role)
            setUser(updated)
            setAccessDraft(toAccessDraft(updated))
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusyId(null)
        }
    }

    const saveRuntimeAccess = async (): Promise<void> => {
        if (!user || !accessDraft) return
        setBusyId('access')
        setError(null)
        try {
            const updated = await client.admin.users.setRuntimeAccess(user.id, {
                statefulSandboxLimit: nonNegativeInt(
                    accessDraft.statefulSandboxLimit
                ),
                alwaysOnlineRuntimeBonus: nonNegativeInt(
                    accessDraft.alwaysOnlineRuntimeBonus
                ),
                activeHoursBonus: nonNegativeInt(accessDraft.activeHoursBonus)
            })
            setUser(updated)
            setAccessDraft(toAccessDraft(updated))
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusyId(null)
        }
    }

    const breadcrumbs = (
        <Breadcrumbs
            items={[
                {
                    label: t('admin.nav.users'),
                    to: adminRoutes.accountUsers
                },
                { label: user?.email ?? id ?? t('admin.nav.users') }
            ]}
        />
    )

    if (loadingUser) {
        return (
            <DetailPage>
                {breadcrumbs}
                <p className='text-caption text-body'>{t('common.loading')}</p>
            </DetailPage>
        )
    }

    if (notFound || !user) {
        return (
            <DetailPage>
                {breadcrumbs}
                <Card elevation='ambient' className='p-2'>
                    <Heading level={3} className='mb-1'>
                        User not found
                    </Heading>
                    <p className='text-caption text-body font-mono'>
                        {id ?? '-'}
                    </p>
                </Card>
            </DetailPage>
        )
    }

    const isSelf = currentUser?.id === user.id
    const canDemote = !(isSelf && user.role === 'admin')
    const nextRole: UserRole = user.role === 'admin' ? 'user' : 'admin'
    const statefulOver = user.statefulSandboxUsage > user.statefulSandboxLimit

    return (
        <DetailPage>
            {breadcrumbs}

            <div className='mb-2.5 flex flex-wrap items-start justify-between gap-2'>
                <div>
                    <Heading level={2} className='mb-1 font-mono break-all'>
                        {user.email}
                    </Heading>
                    <div className='flex flex-wrap items-center gap-2'>
                        <Badge tone={roleTone[user.role]}>
                            {t(`admin.users.roles.${user.role}`)}
                        </Badge>
                        <span className='text-caption text-body font-mono'>
                            {user.id}
                        </span>
                    </div>
                </div>
                <Button
                    variant={user.role === 'admin' ? 'neutral' : 'primary'}
                    size='sm'
                    disabled={busyId === 'role' || !canDemote}
                    title={
                        !canDemote
                            ? t('admin.users.actions.selfHint')
                            : undefined
                    }
                    onClick={() => void setRole(nextRole)}
                >
                    {user.role === 'admin'
                        ? t('admin.users.actions.demote')
                        : t('admin.users.actions.promote')}
                </Button>
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

            <div className='grid gap-2 lg:grid-cols-[minmax(0,1fr)_22rem]'>
                <div className='space-y-2'>
                    <Card elevation='ambient' className='overflow-hidden'>
                        <CardBody className='p-0'>
                            <div className='border-border flex flex-wrap items-center justify-between gap-2 border-b px-2 py-1.5'>
                                <Heading level={3}>Plan &amp; usage</Heading>
                                {planUsage && (
                                    <Badge tone='brand'>
                                        {planUsage.plan.name}
                                    </Badge>
                                )}
                            </div>
                            {planUsageError && (
                                <div className='border-accent-ruby/30 bg-accent-ruby/5 m-2 rounded border px-2 py-1.5'>
                                    <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                                        {planUsageError}
                                    </pre>
                                </div>
                            )}
                            {!planUsage ? (
                                <p className='text-caption text-body p-2'>
                                    {t('common.loading')}
                                </p>
                            ) : (
                                <dl>
                                    <PlanCommerceRows
                                        userId={user.id}
                                        planUsage={planUsage}
                                    />
                                    <DetailRow
                                        label='Usage period'
                                        value={`${formatDateTime(planUsage.usagePeriod.start)} → ${formatDateTime(planUsage.usagePeriod.end)} (${planUsage.usagePeriod.source})`}
                                    />
                                    <DetailRow
                                        label='Stateful sandboxes'
                                        value={`${planUsage.statefulSandboxUsage}/${planUsage.statefulSandboxLimit}`}
                                    />
                                    <DetailRow
                                        label='Concurrent active'
                                        value={`${planUsage.activeSandboxUsage}/${planUsage.plan.maxConcurrentActive}`}
                                    />
                                    <DetailRow
                                        label='Active hours (period)'
                                        value={`${(planUsage.activeHoursThisPeriod ?? 0).toFixed(1)}/${formatLimit(planUsage.plan.monthlyActiveHoursIncluded)}`}
                                    />
                                    <DetailRow
                                        label='Always-online runtimes'
                                        value={`${planUsage.alwaysOnlineRuntimesUsed}/${planUsage.alwaysOnlineRuntimeLimit}`}
                                    />
                                    <DetailRow
                                        label='Always-online agents'
                                        value={`${planUsage.alwaysOnlineAgentsUsed}/${planUsage.alwaysOnlineAgentsLimit}`}
                                    />
                                    <DetailRow
                                        label='Storage'
                                        value={`${formatGb(planUsage.storageBytesTotal)} / ${planUsage.plan.maxStorageGb} GB`}
                                    />
                                    <DetailRow
                                        label='Channels'
                                        value={`${planUsage.channelsUsed}/${planUsage.plan.maxChannels}`}
                                    />
                                    <DetailRow
                                        label='Automations'
                                        value={`${planUsage.automationsUsed}/${planUsage.plan.maxAutomations}`}
                                    />
                                    <DetailRow
                                        label='Automation runs (period)'
                                        value={`${planUsage.automationRunsThisPeriod}/${formatLimit(planUsage.plan.maxAutomationRunsMonthly)}`}
                                    />
                                    <DetailRow
                                        label='API requests (period)'
                                        value={`${formatNumber(planUsage.apiRequestsThisPeriod)}/${formatLimit(planUsage.plan.monthlyApiRequestLimit)}`}
                                    />
                                    <DetailRow
                                        label='Model spend (period)'
                                        value={formatCost(
                                            modelSpend?.totalCostUsd ?? null
                                        )}
                                    />
                                    <DetailRow
                                        label='Model tokens (mo)'
                                        value={
                                            modelSpend
                                                ? `${formatNumber(modelSpend.totalInputTokens)} in · ${formatNumber(modelSpend.totalOutputTokens)} out`
                                                : '-'
                                        }
                                    />
                                    <ManagedSpendRows
                                        userId={user.id}
                                    />
                                </dl>
                            )}
                        </CardBody>
                    </Card>

                    <Card elevation='ambient' className='overflow-hidden'>
                        <CardBody className='p-0'>
                            <div className='border-border border-b px-2 py-1.5'>
                                <Heading level={3}>Runtime access</Heading>
                            </div>
                            <div className='grid gap-2 p-2 sm:grid-cols-2'>
                                <Input
                                    id='statefulSandboxLimit'
                                    type='number'
                                    min={0}
                                    step={1}
                                    label='Stateful sandbox limit'
                                    value={
                                        accessDraft?.statefulSandboxLimit ?? 0
                                    }
                                    className='h-8 px-2'
                                    onChange={(e) =>
                                        setAccessDraft((prev) =>
                                            prev
                                                ? {
                                                      ...prev,
                                                      statefulSandboxLimit:
                                                          Number(e.target.value)
                                                  }
                                                : prev
                                        )
                                    }
                                />
                                <Input
                                    id='alwaysOnlineRuntimeBonus'
                                    type='number'
                                    min={0}
                                    step={1}
                                    label='Always-online runtime bonus'
                                    value={
                                        accessDraft?.alwaysOnlineRuntimeBonus ??
                                        0
                                    }
                                    className='h-8 px-2'
                                    onChange={(e) =>
                                        setAccessDraft((prev) =>
                                            prev
                                                ? {
                                                      ...prev,
                                                      alwaysOnlineRuntimeBonus:
                                                          Number(e.target.value)
                                                  }
                                                : prev
                                        )
                                    }
                                />
                                <Input
                                    id='activeHoursBonus'
                                    type='number'
                                    min={0}
                                    step={1}
                                    label='Active hours bonus'
                                    value={accessDraft?.activeHoursBonus ?? 0}
                                    className='h-8 px-2'
                                    onChange={(e) =>
                                        setAccessDraft((prev) =>
                                            prev
                                                ? {
                                                      ...prev,
                                                      activeHoursBonus: Number(
                                                          e.target.value
                                                      )
                                                  }
                                                : prev
                                        )
                                    }
                                />
                            </div>
                            <div className='border-border flex flex-wrap items-center justify-between gap-2 border-t px-2 py-1.5'>
                                <div className='text-caption-sm text-body'>
                                    Stateful {user.statefulSandboxUsage}/
                                    {user.statefulSandboxLimit}
                                    {statefulOver && (
                                        <span className='text-accent-ruby'>
                                            {' '}
                                            over limit
                                        </span>
                                    )}{' '}
                                    · Always-online runtimes{' '}
                                    {user.alwaysOnlineRuntimesUsed} · agents{' '}
                                    {user.alwaysOnlineAgentsUsed} · bonus{' '}
                                    {user.alwaysOnlineRuntimeBonus}
                                </div>
                                <Button
                                    variant='primary'
                                    size='sm'
                                    disabled={busyId === 'access'}
                                    onClick={() => void saveRuntimeAccess()}
                                >
                                    Save access
                                </Button>
                            </div>
                        </CardBody>
                    </Card>

                    <UserFrameworkRuntimeOverridesCard
                        userId={user.id}
                        onUserUpdated={setUser}
                    />

                    <UserCommerceSection userId={user.id} />
                </div>

                <aside className='space-y-2'>
                    <Card elevation='ambient' className='overflow-hidden'>
                        <CardBody className='p-0'>
                            <div className='border-border border-b px-2 py-1.5'>
                                <Heading level={3}>User</Heading>
                            </div>
                            <dl>
                                <DetailRow label='ID' value={user.id} mono />
                                <DetailRow
                                    label='Email'
                                    value={user.email}
                                    mono
                                />
                                <DetailRow
                                    label='Role'
                                    value={
                                        <Badge tone={roleTone[user.role]}>
                                            {t(
                                                `admin.users.roles.${user.role}`
                                            )}
                                        </Badge>
                                    }
                                />
                                <DetailRow
                                    label='Joined'
                                    value={formatDateTime(user.createdAt)}
                                />
                                <DetailRow
                                    label='Updated'
                                    value={formatDateTime(user.updatedAt)}
                                />
                            </dl>
                        </CardBody>
                    </Card>
                </aside>
            </div>

            <UserContainersSection userId={user.id} />
        </DetailPage>
    )
}

export default UserDetail