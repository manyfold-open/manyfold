import {
    AgentMcpScopeRefreshResult,
    FrameworkMcpScope,
    McpConfigFormat,
    frameworkMcpSupport,
    mcpConfigFromExtras,
    mcpDeliveryFromExtras,
    validateMcpJson
} from '@manyfold/shared'
import type { FC } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { SdkAgent } from '@manyfold/sdk'
import { t } from '@manyfold/i18n'
import { EffectTimingTag } from '@/pages/AgentSettings/SectionHeader'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { frameworkLabel } from '@/lib/frameworkMeta'
import { mcpServerNames } from '@/lib/mcpSnippet'

interface Props {
    agent: SdkAgent
    onAgentUpdated: (agent: SdkAgent) => void
}

const PLACEHOLDER: Record<McpConfigFormat, string> = {
    json: `{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
  }
}`,
    toml: `[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]`
}

// Read-only preview of the managed `composio` server the API injects, in the
// framework's native syntax, with the revealed key. Keep the shape in sync with
// api composio-mcp.ts (JSON shape) and codex-config-toml.ts
// (`mergeComposioIntoCodexMcp` TOML shape).
const COMPOSIO_MCP_URL = 'https://connect.composio.dev/mcp'
const COMPOSIO_KEY_HEADER = 'x-consumer-api-key'

const composioConfigPreview = (framework: string, key: string): string => {
    if (framework === 'codex')
        return [
            '[mcp_servers.composio]',
            `url = "${COMPOSIO_MCP_URL}"`,
            '',
            '[mcp_servers.composio.http_headers]',
            `${COMPOSIO_KEY_HEADER} = "${key}"`
        ].join('\n')
    const headers = { [COMPOSIO_KEY_HEADER]: key }
    const server =
        framework === 'gemini-cli'
            ? { httpUrl: COMPOSIO_MCP_URL, headers }
            : { type: 'http', url: COMPOSIO_MCP_URL, headers }
    return JSON.stringify({ composio: server }, null, 2)
}

export const AgentMcpTools: FC<Props> = ({ agent, onAgentUpdated }) => {
    const client = useApiClient()
    const support = frameworkMcpSupport(agent.framework)
    const stored = useMemo(
        () => mcpConfigFromExtras(agent.extras),
        [agent.extras]
    )
    // A linked Composio connection is injected as a managed `composio` server at
    // materialize time (never stored in extras.mcp). Reveal its key so the preview
    // can show the real token (owner-only; the endpoint denies agent tokens).
    const composioConnectionId =
        (agent.extras as { composioConnectionId?: string | null })
            .composioConnectionId ?? null
    const [composioKey, setComposioKey] = useState<string | null>(null)
    const [syncing, setSyncing] = useState(false)
    const [syncScopes, setSyncScopes] = useState<
        AgentMcpScopeRefreshResult[] | null
    >(null)
    const [syncError, setSyncError] = useState<string | null>(null)
    const [pushing, setPushing] = useState(false)
    useEffect(() => {
        if (!composioConnectionId) {
            setComposioKey(null)
            return
        }
        let alive = true
        void client.connections
            .reveal(composioConnectionId)
            .then((r) => {
                if (alive) setComposioKey(r.apiKey)
            })
            .catch(() => {
                if (alive) setComposioKey(null)
            })
        return () => {
            alive = false
        }
    }, [client, composioConnectionId])

    if (!support) return null

    // Fold the managed composio into the home-dir ($HOME) scope's list (never the
    // workspace `project` scope) so it lists alongside the user's own servers for
    // that file instead of in a separate box.
    const injectedScopeId = composioConnectionId
        ? support.scopes.find((s) => s.path.startsWith('~'))?.id
        : undefined

    const saveScope = async (scopeId: string, text: string): Promise<void> => {
        const next = await client.agents.update(agent.id, {
            mcp: { ...stored, [scopeId]: text }
        })
        setSyncScopes(null)
        setSyncError(null)
        if (agent.runtime === 'daemon') {
            // A daemon has no bootstrap to re-materialize at, so the save
            // pushes synchronously and the per-scope outcome (delivered /
            // skipped needs-CLI / failed offline) lands in extras.mcpDelivery.
            const res = await client.agents.materializeMcp(agent.id)
            onAgentUpdated(res.agent)
            return
        }
        onAgentUpdated(next)
    }

    const pushToRuntime = async (): Promise<void> => {
        if (pushing) return
        setPushing(true)
        setSyncError(null)
        try {
            const res = await client.agents.materializeMcp(agent.id)
            onAgentUpdated(res.agent)
        } catch (err) {
            setSyncError(apiErrorMessage(err))
        } finally {
            setPushing(false)
        }
    }

    const syncFromRuntime = async (): Promise<void> => {
        if (syncing) return
        setSyncing(true)
        setSyncError(null)
        setSyncScopes(null)
        try {
            const res = await client.agents.refreshMcp(agent.id)
            onAgentUpdated(res.agent)
            setSyncScopes(res.scopes)
        } catch (err) {
            setSyncError(apiErrorMessage(err))
        } finally {
            setSyncing(false)
        }
    }

    const scopeLabel = (scopeId: string): string =>
        support.scopes.find((s) => s.id === scopeId)?.label ?? scopeId
    const importedCount = (syncScopes ?? []).filter(
        (s) => s.status === 'imported'
    ).length
    const syncIssues = (syncScopes ?? []).filter(
        (s) => s.status === 'skipped' || s.status === 'error'
    )
    const delivery =
        agent.runtime === 'daemon' ? mcpDeliveryFromExtras(agent.extras) : {}
    const deliveryEntries = Object.entries(delivery)

    return (
        <section>
            <header className='mb-4 flex flex-wrap items-start justify-between gap-3'>
                <div className='min-w-0'>
                    <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
                        <h2 className='text-h3 text-fg tracking-tight'>
                            {t('web.agents.detail.mcp.title')}
                        </h2>
                        <span className='flex-1' />
                        <EffectTimingTag timing='next-turn' />
                    </div>
                    <p className='text-caption text-muted mt-1.5'>
                        {t('web.agents.detail.mcp.description', {
                            framework: frameworkLabel(agent.framework),
                            format: support.format.toUpperCase()
                        })}{' '}
                        {support.scopes.length > 1
                            ? t('web.agents.detail.mcp.multiScopeHint')
                            : null}{' '}
                        {t('web.agents.detail.mcp.applyHint')}
                    </p>
                    {deliveryEntries.length > 0 ? (
                        <div className='mt-2 space-y-1'>
                            {deliveryEntries.map(([scopeId, record]) => (
                                <p
                                    key={scopeId}
                                    className={
                                        record.status === 'failed'
                                            ? 'text-caption text-error'
                                            : 'text-caption text-muted'
                                    }
                                >
                                    {scopeLabel(scopeId)}:{' '}
                                    {record.status === 'delivered'
                                        ? t(
                                              'web.agents.detail.mcp.deliveryDelivered'
                                          )
                                        : record.status === 'skipped'
                                          ? `${t('web.agents.detail.mcp.deliverySkipped')} — ${record.message ?? ''}`
                                          : `${t('web.agents.detail.mcp.deliveryFailed')} — ${record.message ?? ''}`}
                                </p>
                            ))}
                        </div>
                    ) : null}
                    {syncScopes ? (
                        <div className='mt-2 space-y-1'>
                            {importedCount > 0 ? (
                                <p className='text-caption text-muted'>
                                    {t('web.agents.detail.mcp.imported', {
                                        count: importedCount
                                    })}
                                </p>
                            ) : syncIssues.length === 0 ? (
                                <p className='text-caption text-muted'>
                                    {t('web.agents.detail.mcp.alreadySynced')}
                                </p>
                            ) : null}
                            {syncIssues.map((s) => (
                                <p
                                    key={s.scopeId}
                                    className={
                                        s.status === 'error'
                                            ? 'text-caption text-error'
                                            : 'text-caption text-muted'
                                    }
                                >
                                    {scopeLabel(s.scopeId)}:{' '}
                                    {s.message ?? s.status}
                                </p>
                            ))}
                        </div>
                    ) : null}
                </div>
                <div className='flex shrink-0 gap-2'>
                    {agent.runtime === 'daemon' ? (
                        <button
                            type='button'
                            className='workbench-button-secondary'
                            disabled={pushing}
                            onClick={() => void pushToRuntime()}
                        >
                            {pushing
                                ? t('web.agents.detail.mcp.pushing')
                                : t('web.agents.detail.mcp.pushToRuntime')}
                        </button>
                    ) : null}
                    <button
                        type='button'
                        className='workbench-button-secondary'
                        disabled={syncing}
                        onClick={() => void syncFromRuntime()}
                    >
                        {syncing
                            ? t('web.agents.detail.mcp.syncing')
                            : t('web.agents.detail.mcp.syncFromRuntime')}
                    </button>
                </div>
            </header>
            {syncError ? (
                <div className='workbench-alert-error mb-4'>{syncError}</div>
            ) : null}
            <div className='space-y-6'>
                {support.scopes.map((scope) => (
                    <McpScopeSection
                        key={scope.id}
                        scope={scope}
                        format={support.format}
                        multiScope={support.scopes.length > 1}
                        value={stored[scope.id] ?? ''}
                        managed={
                            scope.id === injectedScopeId
                                ? {
                                      names: ['composio'],
                                      preview: composioConfigPreview(
                                          agent.framework,
                                          composioKey ?? '…'
                                      )
                                  }
                                : undefined
                        }
                        onSave={(text) => saveScope(scope.id, text)}
                    />
                ))}
            </div>
        </section>
    )
}

interface SectionProps {
    scope: FrameworkMcpScope
    format: McpConfigFormat
    multiScope: boolean
    value: string
    // The managed servers injected into this scope (e.g. `composio` from a linked
    // connection): their names (listed read-only alongside the user's own) and a
    // read-only preview of their config. Never in the editable text — the config
    // is derived from the connection, not typed here.
    managed?: { names: string[]; preview: string }
    onSave: (text: string) => Promise<void>
}

const McpScopeSection: FC<SectionProps> = ({
    scope,
    format,
    multiScope,
    value,
    managed,
    onSave
}) => {
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(value)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const names = useMemo(() => mcpServerNames(format, value), [format, value])
    const managedNames = managed?.names ?? []
    // Managed wins: if the user also typed a same-named server, only the managed
    // one shows (it overrides on the sprite) — and it dedupes the React key.
    const userNames = names.filter((n) => !managedNames.includes(n))
    const draftError = useMemo(() => {
        const trimmed = draft.trim()
        if (!trimmed || format !== 'json') return null
        return validateMcpJson(trimmed)
    }, [draft, format])

    const startEditing = (): void => {
        setDraft(value)
        setError(null)
        setEditing(true)
    }

    const cancelEditing = (): void => {
        setEditing(false)
        setError(null)
    }

    const save = async (): Promise<void> => {
        if (saving || draftError) return
        setSaving(true)
        setError(null)
        try {
            await onSave(draft.trim())
            setEditing(false)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setSaving(false)
        }
    }

    return (
        <div>
            <div className='mb-2 flex items-start justify-between gap-3'>
                <div>
                    <h3 className='text-ui text-fg font-medium'>
                        {multiScope
                            ? t('web.agents.detail.mcp.scopeTitle', {
                                  scope: scope.label
                              })
                            : t('web.agents.detail.mcp.servers')}
                    </h3>
                    <p className='text-caption text-muted mt-0.5 font-mono break-all'>
                        {scope.path}
                    </p>
                </div>
                {!editing ? (
                    <button
                        type='button'
                        className='workbench-button-secondary shrink-0'
                        onClick={startEditing}
                    >
                        {t('web.agents.detail.edit')}
                    </button>
                ) : null}
            </div>
            {editing ? (
                <div>
                    <textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder={PLACEHOLDER[format]}
                        spellCheck={false}
                        rows={10}
                        className='workbench-textarea font-mono'
                    />
                    {draftError ? (
                        <p className='text-caption text-error mt-2'>
                            {draftError}
                        </p>
                    ) : null}
                    {error ? (
                        <p className='text-caption text-error mt-2'>
                            {error}
                        </p>
                    ) : null}
                    <p className='text-caption text-muted mt-2'>
                        {format === 'json'
                            ? t('web.agents.detail.mcp.jsonHelp')
                            : t('web.agents.detail.mcp.tomlHelp')}
                    </p>
                    {managed ? (
                        <div className='mt-3'>
                            <p className='text-caption text-muted mb-1.5'>
                                {t('web.agents.detail.mcp.managedHelp')}
                            </p>
                            <pre className='workbench-panel text-fg overflow-x-auto px-4 py-3 font-mono text-caption break-all whitespace-pre-wrap'>
                                {managed.preview}
                            </pre>
                        </div>
                    ) : null}
                    <div className='mt-3 flex gap-2'>
                        <button
                            type='button'
                            className='workbench-button-primary'
                            disabled={saving || !!draftError}
                            onClick={() => void save()}
                        >
                            {saving
                                ? t('web.agents.detail.saving')
                                : t('common.save')}
                        </button>
                        <button
                            type='button'
                            className='workbench-button-secondary'
                            disabled={saving}
                            onClick={cancelEditing}
                        >
                            {t('common.cancel')}
                        </button>
                    </div>
                </div>
            ) : userNames.length === 0 && managedNames.length === 0 ? (
                <div className='workbench-note'>
                    {t('web.agents.detail.mcp.empty')}
                </div>
            ) : (
                <ul className='workbench-panel divide-divider divide-y overflow-hidden'>
                    {userNames.map((name) => (
                        <li
                            key={name}
                            className='text-ui text-fg px-5 py-4 font-mono break-all'
                        >
                            {name}
                        </li>
                    ))}
                    {managedNames.map((name) => (
                        <li
                            key={name}
                            className='flex items-center justify-between gap-3 px-5 py-4'
                        >
                            <span className='text-ui text-fg font-mono break-all'>
                                {name}
                            </span>
                            <span className='text-caption text-muted shrink-0'>
                                {t('web.agents.detail.mcp.managedComposio')}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}
