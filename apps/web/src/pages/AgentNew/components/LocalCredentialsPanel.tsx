import type { FC, ReactNode } from 'react'
import { runtimeAuthSupported } from '@manyfold/shared'
import type {
    AgentFramework,
    AgentRuntimeSummary,
    RuntimeAuthListView
} from '@manyfold/shared'
import { GhostSettingsRows } from '@/components/Loading'
import {
    AddChip,
    RuntimeAccountList,
    type AccountListParts
} from '@/components/RuntimeAccountList'
import { NoticeRow } from '@/components/RuntimeDetailPanel'
import { FrameworkLogo, frameworkLabel } from '@/lib/frameworkMeta'
import {
    hostApiKeyEnvFor,
    type ProviderTarget
} from '@/lib/agentCreate/providerSource'
import { useI18n } from '@/lib/i18n'
import type { WakeRefusal } from '@/lib/wakeRefusal'
import type { useRuntimeAuthList } from '@/lib/useRuntimeAuthList'
import { PickerRow } from '@/pages/AgentNew/components/ProviderPicker'

export type RuntimeAuthListState = ReturnType<typeof useRuntimeAuthList>

// A bare sandbox the form is bringing to the account list: probed, the
// CLI installed, its runtime brought up. `cli` is what the last probe said;
// `auto` is whether the form runs the next step unasked (the user's own
// pick) or offers it as a chip (the list's default pick). A missing CLI is
// always a chip — installing changes the sandbox and takes a minute.
export interface SandboxPrepare {
    cli: 'unknown' | 'missing' | 'present'
    auto: boolean
    busy: boolean
    error: string | null
    // The next step for the CLI as last seen: check, install, or prepare.
    onAction: () => void
}

// The rows a runtime can contribute to the provider list: the host sign-in
// plus every account added on it, and how many that is for the chip count.
export const localRowCount = (
    target: ProviderTarget,
    list: RuntimeAuthListView | null,
    // false while a bare sandbox is being prepared or offers its next step
    // instead of the after-create row: nothing is in the grid then.
    placeholderRow = true
): number => {
    if (target.runtimeMode === 'new' || !list) return placeholderRow ? 1 : 0
    return 1 + list.profiles.filter((p) => p.lifecycle !== 'deleted').length
}

// The Local side of the create form's provider section: the credential the
// runtime already holds. On an existing runtime this is the runtime page's
// own account list — same rows, sign-in, menu and API-key form — with the
// pick added: the chosen row is the account the agent runs under.
export const LocalCredentialsPanel: FC<{
    framework: AgentFramework
    target: ProviderTarget
    runtime: AgentRuntimeSummary | null
    auth: RuntimeAuthListState
    // Whether Local is the picked source; rows only show a check when it is.
    active: boolean
    profileId: string
    onSelect: (profileId: string) => void
    // The form asked the API to start this runtime's runner when the runtime
    // was picked; while that is in flight the asleep row reads as progress,
    // not as a button the user still has to press.
    prewarming?: boolean
    // A wake the plan refused, ending the wait; shown in the runner line.
    wakeRefusal?: WakeRefusal | null
    onRetryWake?: () => void
    // Lay the list's parts out in the provider section's own grid and rows.
    layout?: (parts: AccountListParts) => ReactNode
    // Set while the picked target is a bare sandbox whose CLI is installed:
    // its runtime is being brought up (or failed to).
    prepare?: SandboxPrepare | null
    // A runtime the form prepared for an explicit "add account": the list
    // starts its add flow for it once, without a second click.
    autoAddKey?: string | null
}> = ({
    framework,
    target,
    runtime,
    auth,
    active,
    profileId,
    onSelect,
    prewarming = false,
    wakeRefusal = null,
    onRetryWake,
    layout,
    prepare = null,
    autoAddKey = null
}): ReactNode => {
    const { t } = useI18n()
    const listed =
        target.runtimeMode === 'existing' &&
        runtime !== null &&
        runtime.kind !== null &&
        runtimeAuthSupported(runtime.framework, runtime.kind)
    const list = listed ? auth.list : null

    // A runtime that does not exist yet (or cannot be probed) has no accounts
    // to list: the one row is the CLI's own sign-in after the create, and a
    // key can only be set on the host itself.
    const lead = <FrameworkLogo framework={framework} size={16} />
    const newRuntimeRow = (
        <PickerRow
            selected={active}
            onClick={() => onSelect('')}
            lead={lead}
            title={t('web.agentNew.useOwnSubscription')}
            subtitle={t('web.agentNew.subscriptionSignInHint')}
        />
    )
    const newRuntimeNote = (
        <div className='shadow-ring-light bg-soft space-y-1 rounded-md p-4'>
            <p className='text-ui text-fg'>
                {t('web.agentNew.subscriptionSignInExplainer')}
            </p>
            <p className='workbench-hint'>
                {t('web.agentNew.hostApiKeyAfterCreate', {
                    env: hostApiKeyEnvFor(framework)
                })}
            </p>
            <p className='workbench-hint'>
                {t('web.agentNew.subscriptionSignInPrivacy')}
            </p>
        </div>
    )
    const place = (parts: AccountListParts): ReactNode =>
        layout ? (
            layout(parts)
        ) : (
            <div className='grid gap-2'>
                {parts.cards}
                {parts.notices}
            </div>
        )
    const empty = { cards: null, notices: null, actions: null, extra: null }

    if (!listed || !runtime) {
        if (prepare) {
            const inFlight =
                prepare.busy ||
                (prepare.auto && prepare.cli !== 'missing' && !prepare.error)
            if (inFlight)
                return place({
                    ...empty,
                    notices: (
                        <div className='settings-card' aria-busy='true'>
                            <GhostSettingsRows rows={2} action={false} />
                        </div>
                    )
                })
            const label = frameworkLabel(framework)
            return place({
                ...empty,
                notices: prepare.error ? (
                    <NoticeRow
                        tone='danger'
                        title={t('web.agentNew.prepareRuntimeFailed', {
                            framework: label
                        })}
                        detail={prepare.error}
                    />
                ) : prepare.cli === 'missing' ? (
                    <p className='workbench-hint'>
                        {t('web.agentNew.frameworkMissingOnSandbox', {
                            framework: label
                        })}
                    </p>
                ) : null,
                actions: (
                    <AddChip
                        label={
                            prepare.error
                                ? t('common.retry')
                                : prepare.cli === 'unknown'
                                  ? t('web.agentNew.checkSandbox')
                                  : prepare.cli === 'missing'
                                    ? t(
                                          'web.agentNew.installFrameworkOnSandbox',
                                          { framework: label }
                                      )
                                    : t('web.runtimeAuth.addAccount')
                        }
                        onClick={prepare.onAction}
                    />
                )
            })
        }
        return place({
            ...empty,
            cards: newRuntimeRow,
            notices: newRuntimeNote
        })
    }
    if (!list) {
        if (auth.loading)
            return place({
                ...empty,
                notices: (
                    <div className='settings-card' aria-busy='true'>
                        <GhostSettingsRows rows={2} action={false} />
                    </div>
                )
            })
        if (auth.error)
            return place({
                ...empty,
                notices: (
                    <NoticeRow
                        tone='danger'
                        title={t('web.runtimeAuth.listFailed')}
                        detail={auth.error}
                    />
                )
            })
        return null
    }
    if (list.availability === 'unsupported')
        return place({
            ...empty,
            cards: newRuntimeRow,
            notices: newRuntimeNote
        })
    return (
        <RuntimeAccountList
            runtime={runtime}
            list={list}
            loading={auth.loading}
            reload={auth.reload}
            selection={{ profileId, active, onSelect }}
            lead={lead}
            layout={layout}
            prewarming={prewarming}
            wakeRefusal={wakeRefusal}
            onRetryWake={onRetryWake}
            autoAdd={autoAddKey}
        />
    )
}
