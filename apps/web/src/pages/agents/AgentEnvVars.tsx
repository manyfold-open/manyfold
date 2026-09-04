import {
    envTextFromExtras,
    frameworkCapability,
    parseEnvText
} from '@manyfold/shared'
import type { FC } from 'react'
import { useCallback, useMemo, useState } from 'react'
import type { SdkAgent } from '@manyfold/sdk'
import { EffectTimingTag } from '@/pages/AgentSettings/SectionHeader'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { frameworkLabel } from '@/lib/frameworkMeta'
import { useI18n, type TFn } from '@/lib/i18n'
import {
    clearEnvPendingRestart,
    markEnvPendingRestart,
    readEnvPendingRestart
} from '@/lib/envPendingRestart'

const ENV_PLACEHOLDER = (t: TFn): string => `NODE_ENV=production
GIT_AUTHOR_NAME=${t('web.agents.detail.environment.placeholderName')}

${t('web.agents.detail.environment.placeholderMultilineComment')}
CONFIG="key1=val1
key2=val2"`

// Only the variables whose value actually moved get marked pending — a save
// that reformats whitespace should not light up the whole list.
const changedEnvKeys = (before: string, after: string): string[] => {
    const map = (text: string): Map<string, string> =>
        new Map(
            parseEnvText(text).entries.map((entry) => [entry.key, entry.value])
        )
    const from = map(before)
    const to = map(after)
    const keys = new Set<string>()
    for (const [key, value] of to)
        if (from.get(key) !== value) keys.add(key)
    for (const key of from.keys()) if (!to.has(key)) keys.add(key)
    return [...keys]
}

interface Props {
    agent: SdkAgent
    onAgentUpdated: (agent: SdkAgent) => void
}

export const AgentEnvVars: FC<Props> = ({ agent, onAgentUpdated }) => {
    const client = useApiClient()
    const { t } = useI18n()
    const storedEnvText = useMemo(
        () => envTextFromExtras(agent.extras) ?? '',
        [agent.extras]
    )
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(storedEnvText)
    const [saving, setSaving] = useState(false)
    const [restarting, setRestarting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // Re-read after every save/restart so the reminder appears and clears with
    // the obligation rather than only on remount.
    const [pendingTick, setPendingTick] = useState(0)

    const parsed = useMemo(() => parseEnvText(storedEnvText), [storedEnvText])
    const draftParsed = useMemo(() => parseEnvText(draft), [draft])
    // A restart is owed only where a resident service holds the old values: a
    // sprite-hosted service framework. On a daemon every framework spawns per
    // turn (hermes included), so env applies on the next turn (#781).
    const needsRestart =
        frameworkCapability(agent.framework).kind === 'service' &&
        agent.runtime === 'sprites'

    const pending = useMemo(
        () => readEnvPendingRestart(agent.id, agent.startedAt),
        // pendingTick is the re-read trigger: the store is plain localStorage
        // and cannot notify us itself.
        [agent.id, agent.startedAt, pendingTick]
    )
    const pendingKeys = useMemo(() => new Set(pending?.keys ?? []), [pending])

    const applyNow = useCallback(async (): Promise<void> => {
        if (restarting) return
        setRestarting(true)
        setError(null)
        try {
            onAgentUpdated(await client.agents.restart(agent.id))
            clearEnvPendingRestart(agent.id)
            setPendingTick((value) => value + 1)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setRestarting(false)
        }
    }, [agent.id, client, onAgentUpdated, restarting])

    const startEditing = (): void => {
        setDraft(storedEnvText)
        setError(null)
        setEditing(true)
    }

    const cancelEditing = (): void => {
        setEditing(false)
        setError(null)
    }

    const save = async (): Promise<void> => {
        if (saving) return
        if (draftParsed.errors.length > 0) {
            const first = draftParsed.errors[0]
            setError(
                t('web.agents.detail.environment.lineError', {
                    line: first.line,
                    reason: first.reason
                })
            )
            return
        }
        // What the process would run differently, not what the text looks like:
        // reformatting or editing a comment owes nobody a restart.
        const changedKeys = changedEnvKeys(storedEnvText, draft)
        setSaving(true)
        setError(null)
        try {
            const next = await client.agents.update(agent.id, {
                envText: draft
            })
            onAgentUpdated(next)
            setEditing(false)
            // Coding agents pick env up on the next exec, so nothing is owed.
            // Sprite-hosted service frameworks bake env into the running
            // process: the edit is saved but not yet live, and that owes the
            // user a restart until one happens.
            if (needsRestart && changedKeys.length > 0) {
                markEnvPendingRestart(
                    agent.id,
                    changedKeys,
                    Date.parse(next.updatedAt)
                )
                setPendingTick((value) => value + 1)
            }
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setSaving(false)
        }
    }

    return (
        <section>
            <header className='mb-4 flex flex-wrap items-start justify-between gap-3'>
                <div className='min-w-0'>
                    <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
                        <h2 className='text-h3 text-fg'>
                            {t('web.agents.detail.environment.title')}
                        </h2>
                        <span className='flex-1' />
                        <EffectTimingTag
                            timing={needsRestart ? 'restart' : 'next-turn'}
                        />
                    </div>
                    <p className='text-caption text-muted mt-1.5'>
                        {t('web.agents.detail.environment.descriptionPrefix')}{' '}
                        <code>.env</code>{' '}
                        {t('web.agents.detail.environment.descriptionSuffix')}
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
            </header>

            {pending && !editing ? (
                <div className='workbench-alert-warning mb-4 flex flex-wrap items-center gap-x-4 gap-y-2'>
                    <div className='min-w-0 flex-1'>
                        <div className='font-medium'>
                            {t(
                                'web.agents.detail.environment.pendingTitle'
                            )}
                        </div>
                        <div className='text-caption mt-0.5 opacity-90'>
                            {t(
                                'web.agents.detail.environment.pendingDetail',
                                { framework: frameworkLabel(agent.framework) }
                            )}
                        </div>
                    </div>
                    <button
                        type='button'
                        disabled={restarting}
                        onClick={() => void applyNow()}
                        className='workbench-button-secondary shrink-0'
                    >
                        {restarting
                            ? t('web.agentSettings.restart.working')
                            : t('web.agents.detail.environment.restartNow')}
                    </button>
                </div>
            ) : null}

            {/* The banner's own Restart can fail, and the editor's error line is
                not on screen while the banner is — without this the button just
                re-enables and the agent is still running the old values. */}
            {error && !editing ? (
                <p className='text-caption text-error mb-4'>{error}</p>
            ) : null}

            {editing ? (
                <div>
                    <textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder={ENV_PLACEHOLDER(t)}
                        spellCheck={false}
                        rows={10}
                        className='workbench-textarea font-mono'
                    />
                    {draftParsed.errors.length > 0 ? (
                        <ul className='text-caption text-error mt-2 space-y-0.5'>
                            {draftParsed.errors.map((e, i) => (
                                <li key={i}>
                                    {t(
                                        'web.agents.detail.environment.lineError',
                                        {
                                            line: e.line,
                                            reason: e.reason
                                        }
                                    )}
                                </li>
                            ))}
                        </ul>
                    ) : null}
                    {error ? (
                        <p className='text-caption text-error mt-2'>
                            {error}
                        </p>
                    ) : null}
                    {needsRestart ? (
                        <p className='text-caption text-muted mt-2'>
                            {t(
                                'web.agents.detail.environment.serviceRestartHint',
                                {
                                    framework: frameworkLabel(agent.framework)
                                }
                            )}
                        </p>
                    ) : null}
                    <div className='mt-3 flex gap-2'>
                        <button
                            type='button'
                            className='workbench-button-primary'
                            disabled={saving || draftParsed.errors.length > 0}
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
            ) : parsed.entries.length === 0 ? (
                <div className='workbench-note'>
                    {t('web.agents.detail.environment.empty')}
                </div>
            ) : (
                <dl className='workbench-panel divide-divider divide-y overflow-hidden'>
                    {parsed.entries.map((entry, i) => (
                        <div
                            key={`${entry.key}-${i}`}
                            className='grid gap-2 px-5 py-4 md:grid-cols-[11rem_minmax(0,1fr)] md:items-baseline'
                        >
                            <dt className='flex flex-wrap items-baseline gap-2'>
                                <span className='text-ui text-fg break-all font-mono font-medium'>
                                    {entry.key}
                                </span>
                                {pendingKeys.has(entry.key) ? (
                                    <ShortcutTooltip
                                        label={t(
                                            'web.agents.detail.environment.pendingTooltip'
                                        )}
                                    >
                                        <span className='tag tag-warning'>
                                            {t(
                                                'web.agents.detail.environment.pendingTag'
                                            )}
                                        </span>
                                    </ShortcutTooltip>
                                ) : null}
                                {entry.reserved ? (
                                    <ShortcutTooltip
                                        label={t(
                                            'web.agents.detail.environment.reservedTooltip'
                                        )}
                                    >
                                        <span className='text-caption text-warning'>
                                            {t(
                                                'web.agents.detail.environment.reserved'
                                            )}
                                        </span>
                                    </ShortcutTooltip>
                                ) : null}
                            </dt>
                            <dd className='text-ui text-fg whitespace-pre-wrap break-all font-mono'>
                                {entry.value || (
                                    <span className='text-subtle'>
                                        {t(
                                            'web.agents.detail.environment.emptyValue'
                                        )}
                                    </span>
                                )}
                            </dd>
                        </div>
                    ))}
                </dl>
            )}
        </section>
    )
}
