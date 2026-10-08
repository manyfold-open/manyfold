import type { FC, ReactNode } from 'react'
import type {
    AgentFramework,
    RuntimeAuthListView,
    UserModelProviderSummary
} from '@manyfold/shared'
import { providerRowVerdict } from '@manyfold/shared'
import {
    AccountIcon,
    BillingIcon,
    InfoIcon,
    PlusIcon,
    ProviderIcon
} from '@/components/icons'
import { CreateMenu } from '@/components/CreateMenu'
import {
    modelProviderCreateOptions,
    type ModelProviderCreatePick
} from '@/components/ModelProviderCreateDialog'
import { useI18n } from '@/lib/i18n'
import { profileNeedsSignIn } from '@/lib/runtimeAuth'
import { modelProviderForFramework } from '@/lib/agentCreateDraft'
import {
    builtInEntriesFor,
    customProtocolsFor,
    providerFamiliesFor
} from '@/lib/agentCreate/providerSource'
import {
    OptionGroup,
    OptionRow
} from '@/pages/AgentNew/v4/components/OptionRow'
import { frameworkLabel } from '@/lib/frameworkMeta'
import { canUseSubscription } from '@/pages/AgentNew/v4/frameworkCatalog'
import { managedChannelFor } from '@/pages/AgentNew/v4/providerBinding'
import type { MachineBilling } from '@/pages/AgentNew/v4/machineBilling'
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
    // The account-level payer the machine already has, kept as it is.
    | { kind: 'current'; label: string; machine: string }

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
    if (pick.kind === 'current')
        return { kind: 'inherited', label: pick.label, machine: pick.machine }
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
    // What picking managed would leave the agent unable to do — a balance at
    // zero — or null. Shown in the row's price column.
    managedWarning: string | null
    // True when the pick decides which provider the agent is bound to: a
    // service framework INSTALLED with it at create, or a coding CLI bound
    // right after it joins (see `bindsModelAfterJoin`). The API needs a
    // concrete channel plus a model name either way, so a row it would
    // refuse — a protocol this framework cannot speak, a managed channel
    // closed to it, a key never tested — stays on screen, disabled, and says
    // why. When a service agent joins an instance that already runs, it
    // inherits that instance's provider and every row is pickable as before.
    bindsModel: boolean
    // How many agents already run on the machine picked in step ②.
    sharedWith: number
    // What that machine already pays with at the account level, once read —
    // null when it has nothing there or it could not be read. A coding CLI's
    // account-level credential belongs to the runtime, not to one agent, so
    // the row that matches it is the one answer that leaves those agents
    // alone; any other moves them too, which the button says.
    current: MachineBilling | null
    // The machine's name, for the answer that keeps its payer.
    machine: string
    value: CostPick | null
    onChange: (pick: CostPick) => void
    // Adds a key in place, with the settings page's own forms. A user with no
    // saved key used to have to leave for settings — and the flow keeps no
    // progress (decision D), so that cost them every answer already given.
    onAddKey: (pick: ModelProviderCreatePick) => void
    // Opens the edition's top-up dialog; absent where there is nothing to buy
    // or nothing is owed.
    onAddCredit?: () => void
}> = ({
    framework,
    authList,
    authLoading,
    providers,
    managedAvailable,
    managedDetail,
    managedUnavailableReason,
    managedWarning,
    bindsModel,
    sharedWith,
    current,
    machine,
    value,
    onChange,
    onAddKey,
    onAddCredit
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
    const inUseBy = (count: number): string =>
        count === 1
            ? t('web.agentNewV4.cost.inUseByOne')
            : t('web.agentNewV4.cost.inUseBy', { count: String(count) })
    const inUse = inUseBy(sharedWith)
    // A sleeping machine's accounts are what it last reported, so an
    // expiry read from them is a past observation, not a present fact.
    const asleep = authList?.availability === 'sandbox-asleep'
    const keep = (label: string): CostPick => ({
        kind: 'current',
        label,
        machine
    })
    const managedIsCurrent = current?.kind === 'managed'
    // A key on the machine that matches none of the rows below — pasted
    // inline, or saved and since deleted — still gets a row, or keeping it
    // would not be an answer anyone could give.
    const currentElsewhere =
        current !== null &&
        (current.kind === 'key' ||
            (current.kind === 'provider' &&
                !ownKeys.some((p) => p.id === current.providerId)))
    const currentElsewhereLabel =
        current?.kind === 'provider'
            ? current.label
            : t('web.agentNewV4.cost.currentKey')
    const accountLevel = (
        <OptionGroup title={t('web.agentNewV4.cost.accountLevel')}>
            {currentElsewhere && (
                <OptionRow
                    title={currentElsewhereLabel}
                    detail={inUse}
                    mark={<ProviderIcon className='h-5 w-5' />}
                    selected={samePick(value, keep(currentElsewhereLabel))}
                    onSelect={() => onChange(keep(currentElsewhereLabel))}
                />
            )}
            <OptionRow
                title={t('web.agentNewV4.cost.managed')}
                detail={
                    managedIsCurrent ? `${managedDetail} · ${inUse}` : managedDetail
                }
                mark={<BillingIcon className='h-5 w-5' />}
                meta={
                    (managedIsCurrent ? null : managedBlocked) ??
                    managedWarning ??
                    undefined
                }
                selected={
                    managedIsCurrent
                        ? samePick(value, keep(t('web.agentNewV4.cost.managed')))
                        : samePick(value, { kind: 'platform' })
                }
                disabled={!managedIsCurrent && managedBlocked !== null}
                onSelect={() =>
                    onChange(
                        managedIsCurrent
                            ? keep(t('web.agentNewV4.cost.managed'))
                            : { kind: 'platform' }
                    )
                }
            />
            {ownKeys.map((provider) => {
                const isCurrent =
                    current?.kind === 'provider' &&
                    current.providerId === provider.id
                const verdict =
                    bindsModel && !isCurrent
                        ? providerRowVerdict(framework, provider)
                        : 'usable'
                return (
                    <OptionRow
                        key={provider.id}
                        title={provider.providerName}
                        detail={
                            isCurrent
                                ? `${t('web.agentNewV4.cost.ownKeyDetail')} · ${inUse}`
                                : t('web.agentNewV4.cost.ownKeyDetail')
                        }
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
                        selected={
                            isCurrent
                                ? samePick(value, keep(provider.providerName))
                                : samePick(value, {
                                      kind: 'provider',
                                      id: provider.id,
                                      label: provider.providerName
                                  })
                        }
                        disabled={verdict !== 'usable'}
                        onSelect={() =>
                            onChange(
                                isCurrent
                                    ? keep(provider.providerName)
                                    : {
                                          kind: 'provider',
                                          id: provider.id,
                                          label: provider.providerName
                                      }
                            )
                        }
                    />
                )
            })}
        </OptionGroup>
    )
    // The providers this framework can be given, as the add menu offers
    // them: the same catalog subset v1's add chip showed.
    const families = providerFamiliesFor(
        framework,
        modelProviderForFramework(framework)
    )
    const addOptions = modelProviderCreateOptions(
        t,
        [
            ...new Map(
                families
                    .flatMap((family) => builtInEntriesFor(framework, family))
                    .map((entry) => [entry.id, entry])
            ).values()
        ],
        [
            ...new Set(
                families.flatMap((family) =>
                    customProtocolsFor(framework, family)
                )
            )
        ],
        onAddKey
    )
    // Actions, not answers: outside the radio group, and each opens a dialog
    // that finishes here.
    const accountActions = (
        <div className='mt-2 flex flex-wrap gap-2'>
            <CreateMenu
                variant='chip'
                align='left'
                triggerLabel={t('web.agentNewV4.cost.addKey')}
                sheetTitle={t('web.modelProviders.newProvider')}
                options={addOptions}
            />
            {onAddCredit !== undefined && (
                <button
                    type='button'
                    onClick={onAddCredit}
                    className='text-caption text-muted hover:text-fg hover:bg-surface-hover border-divider inline-flex items-center gap-1.5 rounded-md border border-dashed px-3 py-2 transition-colors'
                >
                    <BillingIcon className='h-3.5 w-3.5 shrink-0' />
                    {t('web.agentNewV4.cost.addCredit')}
                </button>
            )}
        </div>
    )
    // A framework that calls a model API rather than carrying its own sign-in
    // has no subscription path, and the list simply has no row for one.
    // Seen on staging [2026-10-08]: an alert here explaining the absence, with
    // a link back to step ①, read as an error on the type the user had just
    // chosen on purpose.
    if (!subscriptionPossible)
        return (
            <>
                {accountLevel}
                {accountActions}
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
                                ? asleep
                                    ? t('web.agentNewV4.cost.expiredLastChecked')
                                    : t('web.agentNewV4.cost.expired')
                                : profile.agentCount > 0
                                  ? inUseBy(profile.agentCount)
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
            {accountActions}
            {/* A sleeping sandbox reports what it last knew rather than being
                woken to answer this list — waking one starts its billed running
                time, and nobody asked for that by arriving on this step.
                It is a read-out, not a warning: a filled alert box would make
                the quietest fact on the screen its heaviest element. */}
            {asleep && (
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

// Step ③ when there is nothing to choose (`fixedCostFor`). The flow passes
// over it, so this is only seen by someone who goes back to it from the bar —
// and then it says where the model comes from instead of offering rows whose
// answer would be ignored.
export const StepCostFixed: FC<{
    cost: CostChoice
    framework: AgentFramework
}> = ({ cost, framework }): ReactNode => {
    const { t } = useI18n()
    const service = frameworkLabel(framework)
    return (
        <Note>
            {cost.kind === 'inherited'
                ? t('web.agentNewV4.cost.inheritedNote', {
                      cli: service,
                      machine: cost.machine
                  })
                : cost.kind === 'runtime-ui'
                  ? t('web.agentNewV4.cost.runtimeUiNote', { service })
                  : t('web.agentNewV4.cost.externalBilled', { service })}
        </Note>
    )
}

const Note: FC<{ children: ReactNode }> = ({ children }): ReactNode => (
    <p className='workbench-alert-info mt-4 flex items-start gap-2'>
        <InfoIcon className='mt-0.5 h-4 w-4 shrink-0' aria-hidden='true' />
        <span>{children}</span>
    </p>
)
