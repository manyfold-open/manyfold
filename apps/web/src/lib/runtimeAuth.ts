import type {
    RuntimeAuthListView,
    RuntimeAuthProfileView
} from '@manyfold/shared'
import type { TagTone } from '@/components/Tag'
import type { TFn } from '@/lib/i18n'

// The select value for "no profile": the agent keeps running on whatever the
// host itself is signed in as (the ambient row on the runtime page).
export const INHERITED_AUTH_OPTION = ''

export type RuntimeAuthProfileSummary = Pick<
    RuntimeAuthProfileView,
    'id' | 'label' | 'lifecycle' | 'credentialStatus' | 'identity'
>

export const profileDisplayName = (
    profile: Pick<RuntimeAuthProfileSummary, 'label' | 'identity'>
): string => profile.identity?.email ?? profile.identity?.name ?? profile.label

// One tag per row. Lifecycle wins over the credential probe: a profile the
// user signed out of stays "Signed out" even while the last probe result is
// stale, and a profile being removed never advertises a live sign-in.
export const profileStatusTag = (
    profile: Pick<RuntimeAuthProfileSummary, 'lifecycle' | 'credentialStatus'>,
    t: TFn
): { tone: TagTone; label: string } => {
    if (profile.lifecycle === 'signed-out')
        return { tone: 'idle', label: t('web.runtimeAuth.signedOut') }
    if (profile.lifecycle === 'deleting' || profile.lifecycle === 'deleted')
        return { tone: 'idle', label: t('web.runtimeAuth.removing') }
    if (profile.lifecycle === 'error')
        return { tone: 'error', label: t('web.runtimeAuth.errorStatus') }
    switch (profile.credentialStatus) {
        case 'valid':
            return {
                tone: 'success',
                label: t('web.runtimeDetails.account.signedIn')
            }
        case 'refresh-required':
        case 'reauth-required':
            return {
                tone: 'warning',
                label: t('web.runtimeDetails.account.expired')
            }
        case 'missing':
            return {
                tone: 'error',
                label: t('web.runtimeDetails.account.notSignedIn')
            }
        default:
            return {
                tone: 'idle',
                label: t('web.runtimeDetails.account.unknownStatus')
            }
    }
}

// Whether an agent can be pointed at the profile at all. A missing or expired
// sign-in still binds (the chat sign-in card then asks for it); only a profile
// on its way out is refused, matching the API's own check.
export const profileBindable = (
    profile: Pick<RuntimeAuthProfileSummary, 'lifecycle'>
): boolean =>
    profile.lifecycle !== 'deleting' && profile.lifecycle !== 'deleted'

export const profileNeedsSignIn = (
    profile: Pick<RuntimeAuthProfileSummary, 'lifecycle' | 'credentialStatus'>
): boolean =>
    profile.lifecycle === 'signed-out' ||
    profile.lifecycle === 'pending' ||
    profile.credentialStatus === 'missing' ||
    profile.credentialStatus === 'reauth-required'

export interface RuntimeAuthOption {
    value: string
    label: string
    disabled: boolean
}

// The picker rows shared by the create wizard and agent settings: the host
// sign-in first, then every profile in list order, named by who it is signed
// in as and suffixed with its status when that status needs attention.
export const runtimeAuthOptions = (
    profiles: readonly RuntimeAuthProfileSummary[],
    t: TFn
): RuntimeAuthOption[] => [
    {
        value: INHERITED_AUTH_OPTION,
        label: t('web.runtimeAuth.inherited'),
        disabled: false
    },
    ...profiles
        .filter((profile) => profile.lifecycle !== 'deleted')
        .map((profile) => {
            const name = profileDisplayName(profile)
            const bindable = profileBindable(profile)
            const status =
                !bindable || profileNeedsSignIn(profile)
                    ? profileStatusTag(profile, t).label
                    : null
            return {
                value: profile.id,
                label: status ? `${name} · ${status}` : name,
                disabled: !bindable
            }
        })
]

// The wizard's starting selection: the runtime's default profile when it is
// still bindable, otherwise the host sign-in. A stale default id (the profile
// was removed) must not pre-select a row the list no longer has.
export const initialRuntimeAuthSelection = (
    list: Pick<RuntimeAuthListView, 'defaultProfileId' | 'profiles'>
): string => {
    const preferred = list.profiles.find(
        (profile) => profile.id === list.defaultProfileId
    )
    return preferred && profileBindable(preferred)
        ? preferred.id
        : INHERITED_AUTH_OPTION
}

// Whether the picker is worth rendering at all: a host that cannot list its
// profiles or has none leaves the agent on the host sign-in with nothing to
// choose, and a host that lists but cannot run under one (old mf) must not
// offer a choice the next turn would refuse.
export const runtimeAuthPickerState = (
    list: RuntimeAuthListView | null
): 'hidden' | 'execute-unsupported' | 'ready' => {
    if (!list || list.availability !== 'ok') return 'hidden'
    const bindable = list.profiles.some(profileBindable)
    if (!bindable) return 'hidden'
    return list.capabilities.execute ? 'ready' : 'execute-unsupported'
}
