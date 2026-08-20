import type {
    LibrarySkillOriginType,
    LibrarySkillSummary
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError } from '@manyfold/sdk'
import EmptyState from '@/components/EmptyState'
import { Ghost } from '@/components/Loading'
import { useLoadingGate } from '@/components/useLoadingGate'
import { PlusIcon, SkillsIcon } from '@/components/icons'
import OverflowMenu from '@/components/OverflowMenu'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { formatDate } from '@/lib/dateFormat'
import { useI18n } from '@/lib/i18n'
import CreateSkillDialog from './CreateSkillDialog'
import CustomizePageHeader from './CustomizePageHeader'
import LibraryInstallDialog from './LibraryInstallDialog'
import ShareSkillDialog from './ShareSkillDialog'

export const librarySkillEditPath = (id: string): string =>
    `/skills/library/edit?id=${encodeURIComponent(id)}`

const ORIGIN_LABEL_KEY: Record<LibrarySkillOriginType, string> = {
    manual: 'web.skills.library.originManual',
    github: 'web.skills.library.originGithub',
    archive: 'web.skills.library.originArchive',
    catalog: 'web.skills.library.originCatalog',
    share: 'web.skills.library.originShare'
}

const downloadBlob = (blob: Blob, filename: string): void => {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

// The delete 409 carries the authoritative installed-agent list in
// error.details; the summary count is the fallback when it is absent.
const installedCountFromError = (err: ApiError, fallback: number): number => {
    const details = err.details as { installedAgentIds?: unknown } | undefined
    const ids = details?.installedAgentIds
    return Array.isArray(ids) && ids.length > 0 ? ids.length : fallback
}

// Ghost twin of this page's library card (DESIGN.md §10.8) — same file
// as the card it mirrors, so a layout change touches both at once.
const ghostLibName = ['w-2/5', 'w-1/2', 'w-1/3', 'w-3/5']
const ghostLibDesc = ['w-11/12', 'w-4/5', 'w-full', 'w-5/6']
const GHOST_LIBRARY_CARDS = [0, 1, 2, 3]

const LibrarySkillCardGhost: FC<{ seed: number }> = ({ seed }): ReactNode => (
    <div className='bg-surface shadow-card flex flex-col gap-3 rounded-md p-4'>
        <div className='flex items-center gap-3'>
            <Ghost variant='tile' className='h-9 w-9 shrink-0' />
            <Ghost variant='line' className={ghostLibName[seed % 4]} />
            <div className='ml-auto flex shrink-0 items-center gap-1.5'>
                <Ghost variant='block' className='h-8 w-16' />
                <Ghost variant='circle' className='h-8 w-8' />
            </div>
        </div>
        <Ghost variant='cap' className={ghostLibDesc[seed % 4]} />
        <Ghost variant='cap' className='mt-auto w-1/3' />
    </div>
)

const LibrarySkills: FC = (): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const navigate = useNavigate()
    const { confirm, confirmDialog } = useProductConfirm()
    const [items, setItems] = useState<LibrarySkillSummary[]>([])
    const [loading, setLoading] = useState(true)
    const gate = useLoadingGate(loading)
    const [busyId, setBusyId] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [createOpen, setCreateOpen] = useState(false)
    const [installTarget, setInstallTarget] =
        useState<LibrarySkillSummary | null>(null)
    const [shareTarget, setShareTarget] = useState<LibrarySkillSummary | null>(
        null
    )

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        client.skills.library
            .list()
            .then((skills) => {
                if (cancelled) return
                setItems(skills)
                setError(null)
            })
            .catch((err: unknown) => {
                if (!cancelled) setError(apiErrorMessage(err))
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [client])

    const exportSkill = async (skill: LibrarySkillSummary): Promise<void> => {
        if (busyId) return
        setBusyId(skill.id)
        setError(null)
        try {
            const { blob, filename } = await client.skills.library.export(
                skill.id
            )
            downloadBlob(blob, filename)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusyId(null)
        }
    }

    const deleteSkill = async (
        skill: LibrarySkillSummary,
        force: boolean
    ): Promise<void> => {
        await client.skills.library.delete(
            skill.id,
            force ? { force: true } : undefined
        )
        setItems((prev) => prev.filter((item) => item.id !== skill.id))
    }

    const removeSkill = async (skill: LibrarySkillSummary): Promise<void> => {
        if (busyId) return
        const confirmed = await confirm({
            title: t('web.skills.library.delete'),
            description: t('web.skills.library.deleteConfirm', {
                name: skill.name
            }),
            confirmLabel: t('web.skills.library.delete'),
            cancelLabel: t('common.cancel'),
            tone: 'danger'
        })
        if (!confirmed) return
        setBusyId(skill.id)
        setError(null)
        try {
            await deleteSkill(skill, false)
        } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
                const forced = await confirm({
                    title: t('web.skills.library.delete'),
                    description: t('web.skills.library.deleteForceConfirm', {
                        count: installedCountFromError(
                            err,
                            skill.installedAgentCount
                        )
                    }),
                    confirmLabel: t('web.skills.library.delete'),
                    cancelLabel: t('common.cancel'),
                    tone: 'danger'
                })
                if (forced) {
                    try {
                        await deleteSkill(skill, true)
                    } catch (err2) {
                        setError(apiErrorMessage(err2))
                    }
                }
            } else {
                setError(apiErrorMessage(err))
            }
        } finally {
            setBusyId(null)
        }
    }

    return (
        <>
            <CustomizePageHeader
                group='skills'
                action={
                    <button
                        type='button'
                        onClick={() => setCreateOpen(true)}
                        className='workbench-button-primary shrink-0 gap-1.5'
                    >
                        <PlusIcon className='h-4 w-4' />
                        {t('web.skills.library.newSkill')}
                    </button>
                }
            />

            {error && <div className='workbench-alert-error mb-5'>{error}</div>}

            {gate.showLoading && (
                <div aria-busy='true' className='grid gap-3 sm:grid-cols-2'>
                    {GHOST_LIBRARY_CARDS.map((seed) => (
                        <LibrarySkillCardGhost key={seed} seed={seed} />
                    ))}
                </div>
            )}

            {!loading && !gate.showLoading && items.length === 0 && !error && (
                <EmptyState
                    kind='first-use'
                    tier='stack'
                    icon={SkillsIcon}
                    title={t('web.skills.library.emptyTitle')}
                    body={t('web.skills.library.empty')}
                    action={{
                        label: t('web.customize.browseSkillsCatalog'),
                        onClick: () => navigate('/skills')
                    }}
                />
            )}

            {!gate.showLoading && items.length > 0 && (
                <div
                    className={
                        gate.fadeIn
                            ? 'loading-fade-in grid gap-3 sm:grid-cols-2'
                            : 'grid gap-3 sm:grid-cols-2'
                    }
                >
                    {items.map((skill) => {
                        const editPath = librarySkillEditPath(skill.id)
                        const busy = busyId === skill.id
                        return (
                            <div
                                key={skill.id}
                                className='bg-surface shadow-card hover:bg-surface-hover group relative flex flex-col gap-3 rounded-md p-4 transition-colors'
                            >
                                <div className='flex items-center gap-3'>
                                    <span className='bg-icon-bg text-icon-fg flex h-9 w-9 shrink-0 items-center justify-center rounded-sm'>
                                        <SkillsIcon className='h-[18px] w-[18px]' />
                                    </span>
                                    <Link
                                        to={editPath}
                                        className='settings-card-label min-w-0 flex-1 truncate after:absolute after:inset-0 after:rounded-md focus-visible:underline'
                                    >
                                        {skill.name}
                                    </Link>
                                    <div className='relative z-10 flex shrink-0 items-center gap-1.5'>
                                        <button
                                            type='button'
                                            disabled={busy}
                                            onClick={() =>
                                                setInstallTarget(skill)
                                            }
                                            className='workbench-button-secondary h-8 px-3'
                                        >
                                            {t('web.skills.library.install')}
                                        </button>
                                        <OverflowMenu
                                            compact
                                            ariaLabel={t(
                                                'web.skills.library.moreActions'
                                            )}
                                            items={[
                                                {
                                                    label: t(
                                                        'web.skills.library.edit'
                                                    ),
                                                    onSelect: () =>
                                                        navigate(editPath)
                                                },
                                                {
                                                    label: t(
                                                        'web.skills.library.export'
                                                    ),
                                                    disabled: busy,
                                                    onSelect: () =>
                                                        void exportSkill(skill)
                                                },
                                                {
                                                    label: t(
                                                        'web.skills.library.share'
                                                    ),
                                                    disabled: busy,
                                                    onSelect: () =>
                                                        setShareTarget(skill)
                                                },
                                                {
                                                    label: t(
                                                        'web.skills.library.delete'
                                                    ),
                                                    danger: true,
                                                    disabled: busy,
                                                    onSelect: () =>
                                                        void removeSkill(skill)
                                                }
                                            ]}
                                        />
                                    </div>
                                </div>
                                {skill.description && (
                                    <p className='text-ui text-muted line-clamp-2'>
                                        {skill.description}
                                    </p>
                                )}
                                <div className='text-caption text-muted mt-auto flex flex-wrap items-center gap-x-1.5 gap-y-1'>
                                    {skill.installedAgentCount > 0 && (
                                        <>
                                            <span>
                                                {t(
                                                    'web.skills.library.installedOn',
                                                    {
                                                        count: skill.installedAgentCount
                                                    }
                                                )}
                                            </span>
                                            <span aria-hidden>·</span>
                                        </>
                                    )}
                                    {skill.origin && (
                                        <>
                                            <span className='tag tag-neutral'>
                                                {t(
                                                    ORIGIN_LABEL_KEY[
                                                        skill.origin.type
                                                    ]
                                                )}
                                            </span>
                                            <span aria-hidden>·</span>
                                        </>
                                    )}
                                    <span>
                                        {t('web.skills.library.updatedOn', {
                                            date: formatDate(skill.updatedAt)
                                        })}
                                    </span>
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}

            {createOpen && (
                <CreateSkillDialog
                    onClose={() => setCreateOpen(false)}
                    onCreated={(skill) =>
                        navigate(
                            skill.origin?.type === 'manual'
                                ? `${librarySkillEditPath(skill.id)}&edit=1`
                                : librarySkillEditPath(skill.id)
                        )
                    }
                />
            )}

            {installTarget && (
                <LibraryInstallDialog
                    skillId={installTarget.id}
                    name={installTarget.name}
                    onClose={() => setInstallTarget(null)}
                />
            )}

            {shareTarget && (
                <ShareSkillDialog
                    skillId={shareTarget.id}
                    name={shareTarget.name}
                    onClose={() => setShareTarget(null)}
                />
            )}

            {confirmDialog}
        </>
    )
}

export default LibrarySkills
