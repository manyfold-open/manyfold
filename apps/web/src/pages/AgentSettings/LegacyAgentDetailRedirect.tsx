import type { FC, ReactNode } from 'react'
import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import { agentSettingsPath } from '@/lib/agentSettingsPath'
import { sectionFromLegacyTab } from '@/lib/agentSettingsSections'

// `/agents/:id?tab=storage` was the address of agent configuration for the
// whole life of the tabbed detail page, so it is in bookmarks, notification
// emails and channel messages. It keeps resolving forever; the mapping lives in
// `agentSettingsSections` and is covered by tests.
const LegacyAgentDetailRedirect: FC = (): ReactNode => {
    const { id } = useParams<{ id: string }>()
    const [searchParams] = useSearchParams()
    if (!id) return <Navigate to='/workspace' replace />

    const section = sectionFromLegacyTab(searchParams.get('tab'))
    // Anything else on the query string (`configureModel=1`) is the target's to
    // interpret, so it rides along.
    const passthrough = new URLSearchParams(searchParams)
    passthrough.delete('tab')
    const query = passthrough.toString()
    const to = agentSettingsPath(id, section) + (query ? `?${query}` : '')
    return <Navigate to={to} replace />
}

export default LegacyAgentDetailRedirect
