import type { FC, ReactNode } from 'react'
import type {
    AgentFramework,
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
import { profileNeedsSignIn } from '@/lib/runtimeAuth'
import {
    OptionGroup,
    OptionRow
} from '@/pages/AgentNew/v4/components/OptionRow'
import { frameworkLabel } from '@/lib/frameworkMeta'
import { canUseSubscription } from '@/pages/AgentNew/v4/frameworkCatalog'
import {
    bindsModelAfterJoin,
    managedChannelFor,
    providerRowVerdict
} from '@/pages/AgentNew/v4/providerBinding'
import { vendorLabel } from '@/pages/AgentNew/v4/vendorLabel'
import type { CostChoice } from '@/pages/AgentNew/v4/flowState'


// Step ③ picks a row the same way step ② does, including the row that starts
// a sign-in rather than answering the question. Keeping one shape for both
// lets the shell describe the primary button from the pick alone — and it is
// why nothing on this screen commits itself: every row waits for the button.
export type CostPick =
    | { kind: 'profile'; id: string; label: string; needsReauth: boolean }
    | { kind: 'platform' }
    | { kind: 'provider'; id: string; label: string }
    | { kind: 'signin' }

export const costChoiceFor = (pick: CostPick): CostChoice | null => {
    if (pick.kind === 'profile')
        return {
            kind: 'runtime-local',
            profileId: pick.id,
            label: pick.label
        }
    if (pick.kind === 'platform') return { kind: 'platform' }
    if (pick.kind === 'provider')
        return { kind: 'provider', providerId: pick.id, label: pick.label }
    return null
}

const samePick = (a: CostPick | null, b: CostPick): boolean => {
    if (a === null || a.kind !== b.kind) return false
    if (a.kind === 'profile' && b.kind === 'profile') return a.id === b.id
    if (a.kind === 'provider' && b.kind === 'provider') return a.id === b.id
    return true
}

// Step ③. The ways to pay look alike but do not reach alike: a vendor sign-in
// is written to ONE machine's disk, while a balance or an API key follows the
// account everywhere. Two headings carry that whole distinction — "On this
// machine" against "On your account" — and nothing more. The clauses those
// headings used to trail were longer than the rows beneath them, which put
// the weight on the chrome instead of the choices; what they explained now
// lives on the question's info mark, and the scope is still legible from the
// contrast between the two names.
//
// Signing in one more account is not a third scope, so it is the last row of
// the first group rather than a group of its own. Step ② separates "A new
// one" because building a machine is a different KIND of act; adding an
// account to the machine you already picked is not.
export const StepCost: FC<{
    framework: AgentFramework
    authList: RuntimeAuthListView | null
    authLoading: boolean
    providers: UserModelProviderSummary[]
    managedAvailable: boolean
    // Composed by the shell, which is where the credit gate lives: "Billed by
    // usage", plus the balance once it is known.
    managedDetail: string
    managedUnavailableReason: string | null
    // True when the pick decides which provider the agent is bound to: a
    // service framework INSTALLED with it at create, or a coding CLI bound
    // right after it joins (see `bindsModelAfterJoin`). The API needs a
    // concrete channel plus a model name either way, so a row it would
    // refuse — a protocol this framework cannot speak, a managed channel
    // closed to it, a key never tested — stays on screen, disabled, and says
    // why. When a service agent joins an instance that already runs, it
    // inherits that instance's provider and every row is pickable as before.
    bindsModel: boolean
    // How many agents already run on the machine picked in step ②. A coding
    // CLI's account-level credential belongs to the machine, not to one
    // agent, so picking one here moves those agents too — said once, under
    // the rows it applies to.
    sharedWith: number
    value: CostPick | null
    onChange: (pick: CostPick) => void
    onBackToType: () => void
}> = ({
    framework,
    authList,
    authLoading,
    providers,
    managedAvailable,
    managedDetail,
    managedUnavailableReason,
    bindsModel,
    sharedWith,
    value,
    onChange,
    onBackToType
}): ReactNode => {
    const { t } = useI18n()
    const vendor = vendorLabel(framework)
    const cli = frameworkLabel(framework)
    const subscriptionPossible = canUseSubscription(framework)
    const profiles = authList?.profiles ?? []
    // Managed supply is already represented by the single "Manyfold managed"
    // row above; listing the individual managed channels again under "your own
    // key" would both double-count the offer and mislabel it.
    const ownKeys = providers.filter((p) => p.source !== 'managed')
    const managedBlocked = !managedAvailable
        ? managedUnavailableReason
        : bindsModel && managedChannelFor(framework, providers) === null
          ? t('web.agentNewV4.cost.managedNoChannel', { cli })
          : null
    const accountLevel = (
        <OptionGroup title={t('web.agentNewV4.cost.accountLevel')}>
            <OptionRow
                title={t('web.agentNewV4.cost.managed')}
                detail={managedDetail}
                mark={<BillingIcon className='h-5 w-5' />}
                meta={managedBlocked ?? undefined}
                selected={samePick(value, { kind: 'platform' })}
                disabled={managedBlocked !== null}
                onSelect={() => onChange({ kind: 'platform' })}
            />
            {ownKeys.map((provider) => {
                const verdict = bindsModel
                    ? providerRowVerdict(framework, provider)
                    : 'usable'
                return (
                    <OptionRow
                        key={provider.id}
                        title={provider.providerName}
                        detail={t('web.agentNewV4.cost.ownKeyDetail')}
                        mark={<ProviderIcon className='h-5 w-5' />}
                        meta={
                            verdict === 'incompatible'
                                ? t('web.agentNewV4.cost.providerIncompatible', {
                                      cli
                                  })
                                : verdict === 'untested'
                                  ? t('web.agentNewV4.cost.providerUntested')
                                  : undefined
                        }
                        selected={samePick(value, {
                            kind: 'provider',
                            id: provider.id,
                            label: provider.providerName
                        })}
                        disabled={verdict !== 'usable'}
                        onSelect={() =>
                            onChange({
                                kind: 'provider',
                                id: provider.id,
                                label: provider.providerName
                            })
                        }
                    />
                )
            })}
        </OptionGroup>
    )
    // Outside the radio group: it is a consequence of the rows above, not one
    // more thing to pick, and it reads the same whichever of them is chosen.
    const sharedNote = bindsModelAfterJoin(framework) && sharedWith > 0 && (
        <p className='text-caption text-subtle mt-2 flex items-start gap-2 px-3'>
            <InfoIcon
                className='mt-0.5 h-3.5 w-3.5 shrink-0'
                aria-hidden='true'
            />
            <span>
                {t('web.agentNewV4.cost.sharedAccount', {
                    count: String(sharedWith)
                })}
            </span>
        </p>
    )
    // A framework that calls a model API rather than carrying its own sign-in
    // has no subscription path at all. Say that in as many words and offer the
    // way back, instead of rendering three greyed-out rows that look like a
    // bug.
    if (!subscriptionPossible)
        return (
            <>
                {accountLevel}
                {sharedNote}
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
            <OptionGroup title={t('web.agentNewV4.cost.onThisMachine')}>
                {profiles.map((profile) => (
                    <OptionRow
                        key={profile.id}
                        title={profile.identity?.email ?? profile.label}
                        detail={
                            profileNeedsSignIn(profile)
                                ? t('web.agentNewV4.cost.expired')
                                : profile.agentCount > 0
                                  ? t('web.agentNewV4.cost.inUseBy', {
                                        count: String(profile.agentCount)
                                    })
                                  : t('web.agentNewV4.cost.signedIn')
                        }
                        mark={<AccountIcon className='h-5 w-5' />}
                        meta={
                            profileNeedsSignIn(profile)
                                ? t('web.agentNewV4.cost.aboutAMinute')
                                : undefined
                        }
                        selected={samePick(value, {
                            kind: 'profile',
                            id: profile.id,
                            label: profile.identity?.email ?? profile.label,
                            needsReauth: profileNeedsSignIn(profile)
                        })}
                        onSelect={() =>
                            onChange({
                                kind: 'profile',
                                id: profile.id,
                                label:
                                    profile.identity?.email ?? profile.label,
                                needsReauth: profileNeedsSignIn(profile)
                            })
                        }
                    />
                ))}
                <OptionRow
                    title={
                        profiles.length === 0
                            ? t('web.agentNewV4.cost.signInTo', { vendor })
                            : t('web.agentNewV4.cost.signInAnother', { vendor })
                    }
                    detail={
                        profiles.length === 0
                            ? t('web.agentNewV4.cost.signInDetail', { vendor })
                            : t('web.agentNewV4.cost.signInAnotherDetail')
                    }
                    mark={
                        profiles.length === 0 ? (
                            <AccountIcon className='h-5 w-5' />
                        ) : (
                            <PlusIcon className='h-5 w-5' />
                        )
                    }
                    meta={t('web.agentNewV4.cost.aboutAMinute')}
                    selected={samePick(value, { kind: 'signin' })}
                    onSelect={() => onChange({ kind: 'signin' })}
                />
                {authLoading && (
                    <p className='text-body text-muted px-3 py-3'>
                        {t('web.agentNewV4.cost.loadingAccounts')}
                    </p>
                )}
            </OptionGroup>
            {accountLevel}
            {sharedNote}
            {/* A sleeping sandbox reports what it last knew rather than being
                woken to answer this list — waking one starts its billed running
                time, and nobody asked for that by arriving on this step.
                It is a read-out, not a warning: a filled alert box would make
                the quietest fact on the screen its heaviest element. */}
            {authList?.availability === 'sandbox-asleep' && (
                <p className='text-caption text-subtle mt-4 flex items-start gap-2 px-3'>
                    <InfoIcon
                        className='mt-0.5 h-3.5 w-3.5 shrink-0'
                        aria-hidden='true'
                    />
                    <span>{t('web.agentNewV4.cost.asleep')}</span>
                </p>
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
