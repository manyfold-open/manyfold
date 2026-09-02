import {
    AgentSkillsGroup,
    InstalledSkillSummary,
    MANYFOLD_CLI_USAGE_SKILL_ID
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Ghost, Spinner } from '@/components/Loading'
import { NoticeRow } from '@/components/RuntimeDetailPanel'
import { StatusTag, Tag } from '@/components/Tag'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'
import { updatesPath } from '@/lib/updateCenter'
import { useLoadingGate } from '@/components/useLoadingGate'
import { shouldPromptFirstPartyInstall } from './firstPartySkill'

// Ghost row widths step per row so the skeleton reads as ragged text
// (literal class strings for the Tailwind content scan).
const ghostRowName = ['w-40', 'w-32', 'w-48']
const ghostRowMeta = ['w-4/5', 'w-3/5', 'w-2/3']
const ghostRowDesc = ['w-1/2', 'w-2/3', 'w-2/5']
const GHOST_ROWS = [0, 1, 2]

interface Props {
    agentId: string
}

const AgentSkillsPanel: FC<Props> = ({ agentId }): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [group, setGroup] = useState<AgentSkillsGroup | null>(null)
    const [loading, setLoading] = useState(true)
    const [busyId, setBusyId] = useState<string | null>(null)
    const [installingFirstParty, setInstallingFirstParty] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // §10.8: only the cold load ghosts the panel; a refresh() with data
    // on screen keeps the panel readable (the acting button already
    // carries its own pending state).
    const gate = useLoadingGate(loading && !group)

    const refresh = async (): Promise<void> => {
        setLoading(true)
        try {
            const groups = await client.skills.installed(agentId, {
                includeRuntime: true
            })
            setGroup(groups[0] ?? null)
            setError(null)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        void refresh()
    }, [client, agentId])

    const updateSkill = (updated: InstalledSkillSummary): void => {
        setGroup((prev) =>
            prev
                ? {
                      ...prev,
                      skills: prev.skills.map((item) =>
                          item.id === updated.id ? updated : item
                      )
                  }
                : prev
        )
    }

    const removeSkill = (skillId: string): void => {
        setGroup((prev) =>
            prev
                ? {
                      ...prev,
                      skills: prev.skills.filter((item) => item.id !== skillId)
                  }
                : prev
        )
    }

    const toggle = async (skill: InstalledSkillSummary): Promise<void> => {
        if (skill.readonly) return
        setBusyId(skill.id)
        setError(null)
        try {
            updateSkill(
                await client.skills.update(skill.id, {
                    enabled: !skill.enabled
                })
            )
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusyId(null)
        }
    }

    const hasUpdate = (skill: InstalledSkillSummary): boolean =>
        !!skill.latestRevision &&
        !!skill.installedRevision &&
        skill.latestRevision !== skill.installedRevision

    const update = async (skill: InstalledSkillSummary): Promise<void> => {
        if (skill.readonly) return
        setBusyId(skill.id)
        setError(null)
        try {
            updateSkill(
                await client.skills.install({
                    skillId: skill.skillId,
                    agentId: skill.agentId
                })
            )
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusyId(null)
        }
    }

    const remove = async (skill: InstalledSkillSummary): Promise<void> => {
        if (skill.readonly) return
        setBusyId(skill.id)
        setError(null)
        try {
            await client.skills.delete(skill.id)
            removeSkill(skill.id)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusyId(null)
        }
    }

    const installFirstParty = async (): Promise<void> => {
        if (installingFirstParty) return
        setInstallingFirstParty(true)
        setError(null)
        try {
            await client.skills.install({
                skillId: MANYFOLD_CLI_USAGE_SKILL_ID,
                agentId
            })
            await refresh()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setInstallingFirstParty(false)
        }
    }

    return (
        <>
            {error && <div className='workbench-alert-error mb-4'>{error}</div>}

            {gate.showLoading && (
                <section
                    aria-busy='true'
                    className='workbench-panel divide-divider divide-y overflow-hidden'
                >
                    <div className='flex flex-wrap items-center justify-between gap-3 px-5 py-4'>
                        <div className='min-w-0'>
                            <div className='text-ui text-fg font-medium'>
                                {t('web.skills.installedTitle')}
                            </div>
                            <Ghost variant='cap' className='mt-2.5 w-16' />
                        </div>
                        <Link
                            to='/skills'
                            className='workbench-button-primary shrink-0'
                        >
                            {t('web.skills.discoverAction')}
                        </Link>
                    </div>
                    {GHOST_ROWS.map((row) => (
                        <div
                            key={row}
                            className='flex flex-wrap items-start justify-between gap-3 px-5 py-4'
                        >
                            <div className='min-w-0 flex-1'>
                                <Ghost
                                    variant='line'
                                    className={ghostRowName[row]}
                                />
                                <Ghost
                                    variant='cap'
                                    className={['mt-2.5', ghostRowMeta[row]]
                                        .filter(Boolean)
                                        .join(' ')}
                                />
                                <Ghost
                                    variant='cap'
                                    className={['mt-2', ghostRowDesc[row]]
                                        .filter(Boolean)
                                        .join(' ')}
                                />
                            </div>
                            <div className='flex shrink-0 items-center gap-2'>
                                <Ghost variant='block' className='h-9 w-20' />
                                <Ghost variant='block' className='h-9 w-24' />
                            </div>
                        </div>
                    ))}
                </section>
            )}

            {!loading &&
                !gate.showLoading &&
                shouldPromptFirstPartyInstall(group) && (
                    <div className='mb-4'>
                        <NoticeRow
                            title={t('web.skills.installFirstPartyTitle')}
                            detail={t('web.skills.installFirstPartyBody')}
                            action={
                                <button
                                    type='button'
                                    disabled={installingFirstParty}
                                    onClick={() => void installFirstParty()}
                                    className='workbench-button-primary'
                                >
                                    {installingFirstParty ? (
                                        <>
                                            <Spinner
                                                size={16}
                                                className='mr-2'
                                            />
                                            {t('web.skills.statusInstalling')}
                                        </>
                                    ) : (
                                        t('web.skills.installAction')
                                    )}
                                </button>
                            }
                        />
                    </div>
                )}

            {!loading && !gate.showLoading && group && (
                <section
                    className={
                        gate.fadeIn
                            ? 'workbench-panel divide-divider loading-fade-in divide-y overflow-hidden'
                            : 'workbench-panel divide-divider divide-y overflow-hidden'
                    }
                >
                    <div className='flex flex-wrap items-center justify-between gap-3 px-5 py-4'>
                        <div className='min-w-0'>
                            <div className='text-ui text-fg font-medium'>
                                {t('web.skills.installedTitle')}
                            </div>
                            <div className='text-ui text-muted mt-1'>
                                {t('web.skills.skillCount', {
                                    count: group.skills.length
                                })}
                            </div>
                        </div>
                        <Link
                            to='/skills'
                            className='workbench-button-primary shrink-0'
                        >
                            {t('web.skills.discoverAction')}
                        </Link>
                    </div>

                    {group.inventoryError && (
                        <div className='px-5 py-4'>
                            <div className='workbench-note'>
                                {t('web.skills.inventoryWarning', {
                                    message: group.inventoryError
                                })}
                            </div>
                        </div>
                    )}

                    {group.skills.length === 0 ? (
                        <div className='px-5 py-4'>
                            <div className='text-ui text-muted'>
                                {t(
                                    group.agent.framework === 'hermes'
                                        ? 'web.skills.emptyHermesAgentBody'
                                        : 'web.skills.emptyAgentBody'
                                )}
                            </div>
                        </div>
                    ) : (
                        group.skills.map((skill) => (
                            <div
                                key={skill.id}
                                className='flex flex-wrap items-start justify-between gap-3 px-5 py-4'
                            >
                                <div className='min-w-0 flex-1'>
                                    <div className='text-ui text-fg font-medium'>
                                        {skill.source === 'library' ? (
                                            <Link
                                                to={`/skills/library/edit?id=${encodeURIComponent(skill.skillId)}`}
                                                className='underline-offset-4 hover:underline'
                                            >
                                                {skill.name}
                                            </Link>
                                        ) : (
                                            skill.name
                                        )}
                                    </div>
                                    <div className='text-ui text-muted mt-1 break-words'>
                                        <Tag>
                                            {t(
                                                skill.source === 'library'
                                                    ? 'web.skills.library.badge'
                                                    : skill.source === 'runtime'
                                                      ? 'web.skills.runtimeSource'
                                                      : 'web.skills.managedSource'
                                            )}
                                        </Tag>
                                        {skill.installedVersion && (
                                            <>
                                                <span> · </span>
                                                <span className='font-mono'>
                                                    v{skill.installedVersion}
                                                </span>
                                            </>
                                        )}
                                        <span> · </span>
                                        <span className='break-all font-mono'>
                                            {skill.installDir}
                                        </span>
                                        <span> · </span>
                                        <span>
                                            {skill.repoOwner}/{skill.repoName}
                                        </span>
                                        <span> · </span>
                                        <span>
                                            {skill.enabled
                                                ? t('web.skills.enabled')
                                                : t('web.skills.disabled')}
                                        </span>
                                        {!skill.readonly &&
                                            skill.materializeStatus ===
                                                'installing' && (
                                                <>
                                                    <span> · </span>
                                                    <StatusTag
                                                        tone='warning'
                                                        label={t(
                                                            'web.skills.statusInstalling'
                                                        )}
                                                    />
                                                </>
                                            )}
                                        {!skill.readonly &&
                                            skill.materializeStatus ===
                                                'failed' && (
                                                <>
                                                    <span> · </span>
                                                    <StatusTag
                                                        tone='error'
                                                        label={t(
                                                            'web.skills.statusFailed'
                                                        )}
                                                    />
                                                </>
                                            )}
                                        {!skill.readonly && hasUpdate(skill) && (
                                            <>
                                                <span> · </span>
                                                <StatusTag
                                                    tone='warning'
                                                    label={t(
                                                        'web.skills.updateAvailable'
                                                    )}
                                                />
                                            </>
                                        )}
                                    </div>
                                    {skill.description && (
                                        <p className='text-ui text-muted mt-2'>
                                            {skill.description}
                                        </p>
                                    )}
                                    {!skill.readonly &&
                                        skill.materializeStatus === 'failed' &&
                                        skill.materializeError && (
                                            <p className='text-ui text-error mt-2 break-words'>
                                                {skill.materializeError}
                                            </p>
                                        )}
                                </div>
                                {skill.readonly ? (
                                    <div className='text-ui text-muted shrink-0'>
                                        {t('web.skills.runtimeReadonly')}
                                    </div>
                                ) : (
                                    <div className='flex shrink-0 flex-wrap items-center gap-2'>
                                        <button
                                            type='button'
                                            disabled={busyId === skill.id}
                                            onClick={() => void toggle(skill)}
                                            className='workbench-button-secondary'
                                        >
                                            {skill.enabled
                                                ? t('web.skills.disableAction')
                                                : t('web.skills.enableAction')}
                                        </button>
                                        {hasUpdate(skill) && (
                                            <Link
                                                to={updatesPath(
                                                    skill.skillId ===
                                                        MANYFOLD_CLI_USAGE_SKILL_ID
                                                        ? 'cliUsage'
                                                        : 'skill'
                                                )}
                                                className='workbench-button-secondary'
                                            >
                                                {t('web.skills.updateAction')}
                                            </Link>
                                        )}
                                        {skill.materializeStatus ===
                                            'failed' && (
                                            <button
                                                type='button'
                                                disabled={busyId === skill.id}
                                                onClick={() =>
                                                    void update(skill)
                                                }
                                                className='workbench-button-secondary'
                                            >
                                                {t('web.skills.retryAction')}
                                            </button>
                                        )}
                                        <button
                                            type='button'
                                            disabled={busyId === skill.id}
                                            onClick={() => void remove(skill)}
                                            className='workbench-button-danger'
                                        >
                                            {t('web.skills.uninstallAction')}
                                        </button>
                                    </div>
                                )}
                            </div>
                        ))
                    )}
                </section>
            )}
        </>
    )
}

export default AgentSkillsPanel
