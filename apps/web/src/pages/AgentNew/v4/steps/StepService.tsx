import type { FC, ReactNode } from 'react'
import type {
    AgentFramework,
    UserExternalAgentProviderSummary
} from '@manyfold/shared'
import { PlugIcon, PlusIcon } from '@/components/icons'
import { useI18n } from '@/lib/i18n'
import {
    remoteIdHintFor,
    remoteIdLabelFor,
    remoteIdPlaceholderFor
} from '@/lib/agentCreate/frameworkOptions'
import {
    OptionGroup,
    OptionRow
} from '@/pages/AgentNew/v4/components/OptionRow'
import { frameworkLabel } from '@/pages/AgentNew/v4/frameworkCatalog'

// Step ② for Dify / Langflow / A2A. Same step, same position in the flow, one
// different question: which app on which service you already run. The backend
// binds these to {providerId, remoteRef}, the same shape as "which CLI on which
// machine", which is why they belong on this path rather than on one of their
// own.
//
// Service and app are two prompts inside ONE step because they come from one
// connection — splitting them into two steps would present them as two
// independent decisions, which they are not.
export const StepService: FC<{
    framework: AgentFramework
    providers: UserExternalAgentProviderSummary[]
    loading: boolean
    error: string | null
    selectedProviderId: string | null
    remoteRef: string
    onSelectProvider: (provider: UserExternalAgentProviderSummary) => void
    onChangeRemoteRef: (value: string) => void
    onConnectNew: () => void
}> = ({
    framework,
    providers,
    loading,
    error,
    selectedProviderId,
    remoteRef,
    onSelectProvider,
    onChangeRemoteRef,
    onConnectNew
}): ReactNode => {
    const { t } = useI18n()
    const service = frameworkLabel(framework)
    return (
        <>
            <OptionGroup
                title={t('web.agentNewV4.service.connected', { service })}
            >
                {providers.map((provider) => (
                    <OptionRow
                        key={provider.id}
                        title={provider.label}
                        detail={provider.endpointUrl}
                        Icon={PlugIcon}
                        meta={
                            provider.lastTestStatus === 'ok'
                                ? t('web.agentNewV4.service.reachable')
                                : provider.lastTestStatus === null
                                  ? undefined
                                  : t('web.agentNewV4.service.lastCheckFailed')
                        }
                        selected={selectedProviderId === provider.id}
                        onSelect={() => onSelectProvider(provider)}
                    />
                ))}
                {!loading && providers.length === 0 && (
                    <p className='text-body text-muted px-3 py-3'>
                        {t('web.agentNewV4.service.none', { service })}
                    </p>
                )}
                {loading && (
                    <p className='text-body text-muted px-3 py-3'>
                        {t('web.agentNewV4.service.loading')}
                    </p>
                )}
            </OptionGroup>
            <OptionGroup title={t('web.agentNewV4.service.connectNewGroup')}>
                <OptionRow
                    title={t('web.agentNewV4.service.connectNew', { service })}
                    detail={t('web.agentNewV4.service.connectNewDetail')}
                    Icon={PlusIcon}
                    onSelect={onConnectNew}
                />
            </OptionGroup>
            {error !== null && (
                <p className='workbench-alert-error mt-4'>{error}</p>
            )}
            {selectedProviderId !== null && (
                <div className='mt-6 px-3'>
                    <label
                        className='workbench-field-label'
                        htmlFor='v4-remote-ref'
                    >
                        {remoteIdLabelFor(framework, t)}
                    </label>
                    <input
                        id='v4-remote-ref'
                        className='workbench-input'
                        value={remoteRef}
                        placeholder={remoteIdPlaceholderFor(framework, t)}
                        onChange={(event) =>
                            onChangeRemoteRef(event.target.value)
                        }
                    />
                    <p className='workbench-hint mt-1.5'>
                        {remoteIdHintFor(framework, t)}
                    </p>
                </div>
            )}
        </>
    )
}
