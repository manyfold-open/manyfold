import type {
    AddRuntimeAgentBody,
    AgentCreateEvent,
    AgentCreateStep,
    AgentRuntimeSummary,
    AgentSummary,
    CreateAgentBody,
    DaemonHostSummary,
    FrameworkAgentSummary,
    RuntimeAccessSummary,
    SandboxSummary,
    UserExternalAgentProviderSummary,
    UserModelProviderSummary
} from '@manyfold/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { trackEvent } from '@/lib/googleAnalytics'
import {
    createAgentCreateRequestKey,
    isAbortError
} from '@/lib/agentCreateDraft'

export interface AgentCreateProgress {
    steps: AgentCreateStep[]
    currentIndex: number
    failedStep: AgentCreateStep | null
    errorMessage: string | null
    done: boolean
}

export interface AgentCreateLoadState {
    providers: UserModelProviderSummary[]
    externalProviders: UserExternalAgentProviderSummary[]
    externalProvidersError: string | null
    runtimes: AgentRuntimeSummary[]
    runtimesError: string | null
    daemonHosts: DaemonHostSummary[]
    sandboxes: SandboxSummary[]
    runtimeAccess: RuntimeAccessSummary | null
    runtimeAgents: Record<string, FrameworkAgentSummary[]>
    runtimeAgentsLoading: boolean
    runtimeAgentsError: string | null
}

export interface UseAgentCreateResult extends AgentCreateLoadState {
    setProviders: React.Dispatch<
        React.SetStateAction<UserModelProviderSummary[]>
    >
    setRuntimes: React.Dispatch<React.SetStateAction<AgentRuntimeSummary[]>>
    refetchRuntimes: () => Promise<void>
    refetchSandboxes: () => Promise<void>
    loadExternalProviders: (kind: 'dify' | 'langflow' | 'a2a') => Promise<void>
    fetchRuntimeAgents: (runtimeId: string) => Promise<void>
    busy: boolean
    progress: AgentCreateProgress | null
    error: string | null
    setError: (message: string | null) => void
    resetProgress: () => void
    submitCreateStream: (input: {
        body: CreateAgentBody
        steps: AgentCreateStep[]
        onCreated?: (created: AgentSummary) => void
    }) => Promise<AgentSummary | null>
    submitAddToRuntime: (input: {
        runtimeId: string
        body: AddRuntimeAgentBody
    }) => Promise<AgentSummary | null>
}

export const useAgentCreate = (): UseAgentCreateResult => {
    const client = useApiClient()

    const [providers, setProviders] = useState<UserModelProviderSummary[]>([])
    const [externalProviders, setExternalProviders] = useState<
        UserExternalAgentProviderSummary[]
    >([])
    const [externalProvidersError, setExternalProvidersError] = useState<
        string | null
    >(null)
    const [runtimes, setRuntimes] = useState<AgentRuntimeSummary[]>([])
    const [runtimesError, setRuntimesError] = useState<string | null>(null)
    const [daemonHosts, setDaemonHosts] = useState<DaemonHostSummary[]>([])
    const [sandboxes, setSandboxes] = useState<SandboxSummary[]>([])
    const [runtimeAccess, setRuntimeAccess] =
        useState<RuntimeAccessSummary | null>(null)
    const [runtimeAgents, setRuntimeAgents] = useState<
        Record<string, FrameworkAgentSummary[]>
    >({})
    const [runtimeAgentsLoading, setRuntimeAgentsLoading] = useState(false)
    const [runtimeAgentsError, setRuntimeAgentsError] = useState<string | null>(
        null
    )
    const [busy, setBusy] = useState(false)
    const [progress, setProgress] = useState<AgentCreateProgress | null>(null)
    const [error, setError] = useState<string | null>(null)
    const controllerRef = useRef<AbortController | null>(null)
    const externalLoadKeyRef = useRef<string | null>(null)

    useEffect(() => {
        let cancelled = false
        client.modelProviders
            .list()
            .then((rows) => {
                if (!cancelled) setProviders(rows)
            })
            .catch(() => {
                if (!cancelled) setProviders([])
            })
        return () => {
            cancelled = true
        }
    }, [client])

    // Runtimes and daemon hosts are refetched together: a freshly-connected
    // machine that lacks the target framework has no runtime row yet, so the
    // reuse list leans on the host list (with its detected frameworks) to show
    // it as an unavailable option. `refetchRuntimes` powers both the reuse
    // list's refresh control and the post-connect-dialog refresh.
    const refetchRuntimes = useCallback(async (): Promise<void> => {
        const [runtimeResult, hostResult] = await Promise.allSettled([
            client.agentRuntimes.list(),
            client.daemons.listHosts()
        ])
        if (runtimeResult.status === 'fulfilled') {
            setRuntimes(runtimeResult.value)
            setRuntimesError(null)
        } else {
            setRuntimesError(apiErrorMessage(runtimeResult.reason))
        }
        if (hostResult.status === 'fulfilled') setDaemonHosts(hostResult.value)
    }, [client])

    useEffect(() => {
        void refetchRuntimes()
    }, [refetchRuntimes])

    // A sandbox created from inside the picker has no runtime row yet, so the
    // attach list only learns about it from this list.
    const refetchSandboxes = useCallback(async (): Promise<void> => {
        try {
            setSandboxes(await client.sandboxes.list())
        } catch {
            // A failed refresh leaves the previous list in place: the picker
            // stays usable, and the row the caller just created shows up on the
            // next successful load.
        }
    }, [client])

    useEffect(() => {
        void refetchSandboxes()
    }, [refetchSandboxes])

    useEffect(() => {
        let cancelled = false
        client.runtimeAccess
            .summary()
            .then((row) => {
                if (!cancelled) setRuntimeAccess(row)
            })
            .catch(() => {
                if (!cancelled) setRuntimeAccess(null)
            })
        return () => {
            cancelled = true
        }
    }, [client])

    useEffect(
        () => () => {
            controllerRef.current?.abort()
            controllerRef.current = null
        },
        []
    )

    const loadExternalProviders = useCallback(
        async (kind: 'dify' | 'langflow' | 'a2a'): Promise<void> => {
            const key = `${kind}:${Date.now()}`
            externalLoadKeyRef.current = key
            setExternalProvidersError(null)
            try {
                const rows = await client.externalAgentProviders.list(kind)
                if (externalLoadKeyRef.current !== key) return
                setExternalProviders(rows)
            } catch (err) {
                if (externalLoadKeyRef.current !== key) return
                setExternalProviders([])
                setExternalProvidersError((err as Error).message)
            }
        },
        [client]
    )

    const fetchRuntimeAgents = useCallback(
        async (runtimeId: string): Promise<void> => {
            if (!runtimeId) return
            if (runtimeAgents[runtimeId]) return
            setRuntimeAgentsLoading(true)
            setRuntimeAgentsError(null)
            try {
                const rows = await client.agentRuntimes.listAgents(runtimeId)
                setRuntimeAgents((prev) => ({ ...prev, [runtimeId]: rows }))
            } catch (err) {
                setRuntimeAgentsError((err as Error).message)
            } finally {
                setRuntimeAgentsLoading(false)
            }
        },
        [client, runtimeAgents]
    )

    const resetProgress = useCallback((): void => {
        controllerRef.current?.abort()
        controllerRef.current = null
        setBusy(false)
        setProgress(null)
        setError(null)
    }, [])

    const submitCreateStream = useCallback(
        async ({
            body,
            steps,
            onCreated
        }: {
            body: CreateAgentBody
            steps: AgentCreateStep[]
            onCreated?: (created: AgentSummary) => void
        }): Promise<AgentSummary | null> => {
            controllerRef.current?.abort()
            const controller = new AbortController()
            controllerRef.current = controller
            setBusy(true)
            setError(null)
            setProgress({
                steps,
                currentIndex: -1,
                failedStep: null,
                errorMessage: null,
                done: false
            })
            try {
                const created = await client.agents.createStream(
                    body,
                    (ev: AgentCreateEvent) => {
                        if (ev.type === 'step') {
                            setProgress((p) =>
                                p ? { ...p, currentIndex: ev.index } : p
                            )
                        }
                        if (ev.type === 'error') {
                            setProgress((p) =>
                                p
                                    ? {
                                          ...p,
                                          failedStep: ev.step,
                                          errorMessage: ev.message,
                                          done: true
                                      }
                                    : p
                            )
                        }
                    },
                    {
                        signal: controller.signal,
                        idempotencyKey: createAgentCreateRequestKey()
                    }
                )
                setProgress((p) =>
                    p ? { ...p, currentIndex: p.steps.length, done: true } : p
                )
                // One call site covers all three AgentNew variants; the admin
                // funnel stays the source of truth, this is GA colour only.
                trackEvent('agent_created', { method: 'create' })
                onCreated?.(created)
                return created
            } catch (err) {
                if (isAbortError(err)) return null
                const message = apiErrorMessage(err)
                setError(message)
                setProgress((p) =>
                    p
                        ? {
                              ...p,
                              errorMessage: p.errorMessage ?? message,
                              done: true
                          }
                        : p
                )
                return null
            } finally {
                if (controllerRef.current === controller) {
                    controllerRef.current = null
                    setBusy(false)
                }
            }
        },
        [client]
    )

    const submitAddToRuntime = useCallback(
        async ({
            runtimeId,
            body
        }: {
            runtimeId: string
            body: AddRuntimeAgentBody
        }): Promise<AgentSummary | null> => {
            setBusy(true)
            setError(null)
            try {
                const created = await client.agentRuntimes.addAgent(
                    runtimeId,
                    body
                )
                trackEvent('agent_created', { method: 'attach' })
                return created
            } catch (err) {
                setError(apiErrorMessage(err))
                return null
            } finally {
                setBusy(false)
            }
        },
        [client]
    )

    return {
        providers,
        externalProviders,
        externalProvidersError,
        runtimes,
        runtimesError,
        daemonHosts,
        sandboxes,
        runtimeAccess,
        runtimeAgents,
        runtimeAgentsLoading,
        runtimeAgentsError,
        setProviders,
        setRuntimes,
        refetchRuntimes,
        refetchSandboxes,
        loadExternalProviders,
        fetchRuntimeAgents,
        busy,
        progress,
        error,
        setError,
        resetProgress,
        submitCreateStream,
        submitAddToRuntime
    }
}
