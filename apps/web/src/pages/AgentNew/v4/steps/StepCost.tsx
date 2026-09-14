import type { FC, ReactNode } from 'react'
import type {
    AgentFramework,
    RuntimeAuthCredentialStatus,
    RuntimeAuthListView,
    UserModelProviderSummary
} from '@manyfold/shared'
import {
    AccountIcon,
    BillingIcon,
    InfoIcon,
    PlusIcon,
    ProviderIcon
} from '@/components/icons'
import { useI18n } from '@/lib/i18n'
import {
    OptionGroup,
    OptionRow
} from '@/pages/AgentNew/v4/components/OptionRow'
import {
    canUseSubscription,
    frameworkLabel,
    vendorLabel
} from '@/pages/AgentNew/v4/frameworkCatalog'
import type { CostChoice } from '@/pages/AgentNew/v4/flowState'

// A credential the host can no longer use without the user going back to the
// vendor. Both states mean the same thing to whoever is choosing here: picking
// this account costs a sign-in.
const needsReauth = (status: RuntimeAuthCredentialStatus): boolean =>
    status === 'reauth-required' || status === 'missing'

const isSameChoice = (a: CostChoice | null, b: CostChoice): boolean => {
    if (a === null) return false
    if (a.kind !== b.kind) return false
    if (a.kind === 'runtime-local' && b.kind === 'runtime-local')
        return a.profileId === b.profileId
    if (a.kind === 'provider' && b.kind === 'provider')
        return a.providerId === b.providerId
    return true
}

// Step ③. The three ways to pay look alike but do not reach alike: a vendor
// sign-in is written to ONE machine's disk, while a balance or an API key
// follows the account to every machine. Grouping by scope — and saying the
// scope on the group heading — is the only way the difference is visible at
// the moment of choosing. The question itself carries the machine name for
// the same reason.
export const StepCost: FC<{
    framework: AgentFramework
    machineLabel: string
    authList: RuntimeAuthListView | null
    authLoading: boolean
    providers: UserModelProviderSummary[]
    managedAvailable: boolean
    managedUnavailableReason: string | null
    value: CostChoice | null
    onChange: (choice: CostChoice) => void
    onAddAccount: () => void
    onBackToType: () => void
}> = ({
    framework,
    machineLabel,
    authList,
    authLoading,
    providers,
    managedAvailable,
    managedUnavailableReason,
    value,
    onChange,
    onAddAccount,
    onBackToType
}): ReactNode => {
    const { t } = useI18n()
    const vendor = vendorLabel(framework)
    const subscriptionPossible = canUseSubscription(framework)
    const profiles = authList?.profiles ?? []
    // Managed supply is already represented by the single "Manyfold managed"
    // row above; listing the individual managed channels again under "your own
    // key" would both double-count the offer and mislabel it.
    const ownKeys = providers.filter((p) => p.source !== 'managed')
    const accountLevel = (
        <OptionGroup
            title={
                subscriptionPossible
                    ? t('web.agentNewV4.cost.accountLevelAlt')
                    : t('web.agentNewV4.cost.accountLevel')
            }
            hint={t('web.agentNewV4.cost.accountLevelHint')}
        >
            <OptionRow
                title={t('web.agentNewV4.cost.managed')}
                detail={t('web.agentNewV4.cost.managedDetail')}
                Icon={BillingIcon}
                meta={
                    managedAvailable
                        ? t('web.agentNewV4.cost.readyNow')
                        : managedUnavailableReason
                }
                selected={isSameChoice(value, { kind: 'platform' })}
                disabled={!managedAvailable}
                onSelect={() => onChange({ kind: 'platform' })}
            />
            {ownKeys.map((provider) => (
                <OptionRow
                    key={provider.id}
                    title={provider.providerName}
                    detail={t('web.agentNewV4.cost.ownKeyDetail')}
                    Icon={ProviderIcon}
                    selected={isSameChoice(value, {
                        kind: 'provider',
                        providerId: provider.id,
                        label: provider.providerName
                    })}
                    onSelect={() =>
                        onChange({
                            kind: 'provider',
                            providerId: provider.id,
                            label: provider.providerName
                        })
                    }
                />
            ))}
        </OptionGroup>
    )
    // A framework that calls a model API rather than carrying its own sign-in
    // has no subscription path at all. Say that in as many words and offer the
    // way back, instead of rendering three greyed-out rows that look like a
    // bug.
    if (!subscriptionPossible)
        return (
            <>
                {accountLevel}
                <Note>
                    {t('web.agentNewV4.cost.noSubscriptionFor', { vendor })}
                    <button
                        type='button'
                        className='text-link ml-1.5 underline-offset-2 hover:underline'
                        onClick={onBackToType}
                    >
                        {t('web.agentNewV4.cost.backToType')}
                    </button>
                </Note>
            </>
        )
    return (
        <>
            <OptionGroup
                title={t('web.agentNewV4.cost.onThisMachine', {
                    vendor,
                    machine: machineLabel
                })}
                hint={t('web.agentNewV4.cost.onThisMachineHint')}
            >
                {profiles.map((profile) => (
                    <OptionRow
                        key={profile.id}
                        title={profile.identity?.email ?? profile.label}
                        detail={
                            needsReauth(profile.credentialStatus)
                                ? t('web.agentNewV4.cost.expired')
                                : profile.agentCount > 0
                                  ? t('web.agentNewV4.cost.inUseBy', {
                                        count: String(profile.agentCount)
                                    })
                                  : t('web.agentNewV4.cost.signedIn')
                        }
                        Icon={AccountIcon}
                        meta={
                            needsReauth(profile.credentialStatus)
                                ? t('web.agentNewV4.cost.aboutAMinute')
                                : undefined
                        }
                        selected={isSameChoice(value, {
                            kind: 'runtime-local',
                            profileId: profile.id,
                            label: profile.identity?.email ?? profile.label
                        })}
                        onSelect={() =>
                            onChange({
                                kind: 'runtime-local',
                                profileId: profile.id,
                                label: profile.identity?.email ?? profile.label
                            })
                        }
                    />
                ))}
                {profiles.length === 0 && (
                    <OptionRow
                        title={t('web.agentNewV4.cost.signInTo', { vendor })}
                        detail={t('web.agentNewV4.cost.signInDetail', {
                            machine: machineLabel
                        })}
                        Icon={AccountIcon}
                        meta={t('web.agentNewV4.cost.aboutAMinute')}
                        onSelect={onAddAccount}
                    />
                )}
                {authLoading && (
                    <p className='text-body text-muted px-3 py-3'>
                        {t('web.agentNewV4.cost.loadingAccounts')}
                    </p>
                )}
            </OptionGroup>
            {accountLevel}
            {profiles.length > 0 && (
                <OptionGroup
                    title={t('web.agentNewV4.cost.oneMore')}
                    hint={t('web.agentNewV4.cost.oneMoreHint', {
                        machine: machineLabel
                    })}
                >
                    <OptionRow
                        title={t('web.agentNewV4.cost.signInAnother', {
                            vendor
                        })}
                        detail={t('web.agentNewV4.cost.signInAnotherDetail')}
                        Icon={PlusIcon}
                        meta={t('web.agentNewV4.cost.aboutAMinute')}
                        onSelect={onAddAccount}
                    />
                </OptionGroup>
            )}
            {/* A sleeping sandbox reports what it last knew rather than being
                woken to answer this list — waking one starts its billed running
                time, and nobody asked for that by arriving on this step. */}
            {authList?.availability === 'sandbox-asleep' && (
                <Note>{t('web.agentNewV4.cost.asleep')}</Note>
            )}
        </>
    )
}

// The step still appears for a connected service, with nothing to pick. Every
// run of the flow is then the same four steps, so nobody has to remember that
// one kind of agent is shorter.
export const StepCostExternal: FC<{ framework: AgentFramework }> = ({
    framework
}): ReactNode => {
    const { t } = useI18n()
    return (
        <Note>
            {t('web.agentNewV4.cost.externalBilled', {
                service: frameworkLabel(framework)
            })}
        </Note>
    )
}

const Note: FC<{ children: ReactNode }> = ({ children }): ReactNode => (
    <p className='workbench-alert-info mt-4 flex items-start gap-2'>
        <InfoIcon className='mt-0.5 h-4 w-4 shrink-0' aria-hidden='true' />
        <span>{children}</span>
    </p>
)
