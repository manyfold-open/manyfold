import type {
    AgentFramework,
    AgentModelConfigView
} from '@manyfold/shared'
import { useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import {
    mergeCachedRuntimeLocalModelConfigView,
    readCachedModelConfigView,
    subscribeModelConfigViewUpdates,
    writeCachedModelConfigView
} from '@/lib/agentModelConfig'
import { automationModelConfigResourceKey } from './automationModelConfigResource'

interface AutomationModelConfigState {
    key: string | null
    view: AgentModelConfigView | null
    loading: boolean
    error: string | null
}

export interface AutomationModelConfigResource {
    view: AgentModelConfigView | null
    loading: boolean
    error: string | null
}

export const useAutomationModelConfig = (
    agentId: string | null | undefined,
    framework: AgentFramework | null | undefined
): AutomationModelConfigResource => {
    const client = useApiClient()
    const key = automationModelConfigResourceKey(agentId, framework)
    const [state, setState] = useState<AutomationModelConfigState>({
        key: null,
        view: null,
        loading: false,
        error: null
    })

    useEffect(() => {
        if (!key || !agentId || !framework) {
            setState((previous) =>
                previous.key === null &&
                previous.view === null &&
                !previous.loading &&
                previous.error === null
                    ? previous
                    : {
                          key: null,
                          view: null,
                          loading: false,
                          error: null
                      }
            )
            return
        }

        let cancelled = false
        const cached = readCachedModelConfigView(agentId)
        const usableCached = cached?.framework === framework ? cached : null
        setState({
            key,
            view: usableCached,
            loading: !usableCached,
            error: null
        })
        client.agents
            .getModelConfig(agentId)
            .then((view) => {
                if (cancelled) return
                const currentCached =
                    readCachedModelConfigView(agentId) ?? usableCached
                const next = mergeCachedRuntimeLocalModelConfigView(
                    view,
                    currentCached
                )
                writeCachedModelConfigView(next)
                setState({
                    key,
                    view: next,
                    loading: false,
                    error: null
                })
            })
            .catch((error) => {
                if (cancelled) return
                setState((previous) =>
                    previous.key === key
                        ? {
                              ...previous,
                              loading: false,
                              error: apiErrorMessage(error)
                          }
                        : previous
                )
            })

        return () => {
            cancelled = true
        }
    }, [agentId, client, framework, key])

    useEffect(() => {
        if (!key || !agentId || !framework) return
        return subscribeModelConfigViewUpdates(agentId, (view) => {
            if (view.framework !== framework) return
            setState({
                key,
                view,
                loading: false,
                error: null
            })
        })
    }, [agentId, framework, key])

    if (state.key !== key)
        return {
            view: null,
            loading: key !== null,
            error: null
        }

    return {
        view: state.view,
        loading: state.loading,
        error: state.error
    }
}
