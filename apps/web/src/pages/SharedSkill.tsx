import type {
    LibrarySkillImportConflict,
    SharedSkillPreview
} from '@manyfold/shared'
import { useEffect, useState, type FC, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ApiError } from '@manyfold/sdk'
import { BrandMark } from '@/components/Brand'
import MarkdownText from '@/components/chat/MarkdownText'
import { SignedIn, SignedOut } from '@/lib/auth'
import { useApiClient } from '@/lib/apiClient'
import { Ghost, Spinner } from '@/components/Loading'
import { apiErrorDetailMessage, apiErrorMessage } from '@/lib/errorMessage'
import { formatDate } from '@/lib/dateFormat'
import { loginUrl } from '@/lib/loginRedirect'
import { useI18n } from '@/lib/i18n'
import { importConflictName } from '@/pages/Customize/CreateSkillDialog'
import { librarySkillEditPath } from '@/pages/Customize/LibrarySkills'

type ViewState =
    | { kind: 'checking' }
    | { kind: 'ok'; preview: SharedSkillPreview }
    | { kind: 'not_found' }
    | { kind: 'error'; message: string }

const SharedSkill: FC = (): ReactNode => {
    const { t } = useI18n()
    const { shareId } = useParams<{ shareId: string }>()
    const client = useApiClient()
    const navigate = useNavigate()
    const [view, setView] = useState<ViewState>({ kind: 'checking' })
    const [busy, setBusy] = useState(false)
    const [conflict, setConflict] = useState<string | null>(null)
    const [importError, setImportError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        if (!shareId) {
            setView({ kind: 'not_found' })
            return
        }
        client.skills
            .resolveSharedSkill(shareId)
            .then((preview) => {
                if (!cancelled) setView({ kind: 'ok', preview })
            })
            .catch((err: unknown) => {
                if (cancelled) return
                if (err instanceof ApiError && err.status === 404) {
                    setView({ kind: 'not_found' })
                    return
                }
                setView({ kind: 'error', message: apiErrorMessage(err) })
            })
        return () => {
            cancelled = true
        }
    }, [shareId, client])

    const runImport = async (
        onConflict?: LibrarySkillImportConflict
    ): Promise<void> => {
        if (!shareId || busy) return
        setBusy(true)
        setConflict(null)
        setImportError(null)
        try {
            const result = await client.skills.library.import({
                shareId,
                onConflict
            })
            navigate(librarySkillEditPath(result.skill.id))
        } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
                const existing = importConflictName(err)
                setConflict(
                    existing
                        ? t('web.skills.library.conflictMessage', {
                              name: existing
                          })
                        : apiErrorDetailMessage(err)
                )
            } else {
                setImportError(apiErrorMessage(err))
            }
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className='bg-main min-h-dvh'>
            <div className='mx-auto w-full max-w-3xl px-5 py-10'>
                <Link
                    to='/'
                    aria-label='Manyfold'
                    className='text-fg mb-8 inline-flex items-center gap-2 font-medium'
                >
                    <BrandMark className='h-6 w-6' />
                    <span>Manyfold</span>
                </Link>

                {view.kind === 'checking' && (
                    <div aria-busy='true'>
                        <Ghost variant='title' className='w-48' />
                        <Ghost variant='cap' className='mt-3 w-72 max-w-full' />
                        <div className='workbench-panel mt-6 space-y-3 px-5 py-5'>
                            <Ghost variant='line' className='w-1/4' />
                            <Ghost variant='cap' className='w-3/5' />
                            <Ghost variant='cap' className='w-2/5' />
                        </div>
                    </div>
                )}

                {view.kind === 'not_found' && (
                    <div className='workbench-panel px-6 py-8'>
                        <h1 className='text-h2 text-fg tracking-tight'>
                            {t('web.skills.shared.notFoundTitle')}
                        </h1>
                        <p className='text-ui text-muted mt-2'>
                            {t('web.skills.shared.notFoundBody')}
                        </p>
                        <Link
                            to='/'
                            className='workbench-button-secondary mt-5 inline-flex'
                        >
                            {t('web.skills.shared.backHome')}
                        </Link>
                    </div>
                )}

                {view.kind === 'error' && (
                    <div className='workbench-alert-error'>{view.message}</div>
                )}

                {view.kind === 'ok' && (
                    <>
                        <div className='mb-5 flex flex-wrap items-start justify-between gap-3'>
                            <div className='min-w-0'>
                                <h1 className='text-h2 text-fg tracking-tight'>
                                    {view.preview.skill.name}
                                </h1>
                                <p className='text-caption text-muted mt-1'>
                                    {view.preview.sharedBy
                                        ? t('web.skills.shared.sharedBy', {
                                              name: view.preview.sharedBy
                                          })
                                        : t('web.skills.shared.sharedAnon')}
                                    {' · '}
                                    {formatDate(view.preview.skill.updatedAt)}
                                </p>
                                {view.preview.skill.description && (
                                    <p className='text-ui text-muted mt-2 break-words'>
                                        {view.preview.skill.description}
                                    </p>
                                )}
                            </div>
                            <div className='shrink-0'>
                                <SignedIn>
                                    <button
                                        type='button'
                                        disabled={busy}
                                        onClick={() => void runImport()}
                                        className='workbench-button-primary'
                                    >
                                        {busy ? (
                                            <>
                                                <Spinner
                                                    size={16}
                                                    className='mr-2'
                                                />
                                                {t('common.importing')}
                                            </>
                                        ) : (
                                            t('web.skills.shared.import')
                                        )}
                                    </button>
                                </SignedIn>
                                <SignedOut>
                                    <Link
                                        to={loginUrl(
                                            `/skills/shared/${shareId ?? ''}`
                                        )}
                                        className='workbench-button-primary inline-flex'
                                    >
                                        {t('web.skills.shared.signInToImport')}
                                    </Link>
                                </SignedOut>
                            </div>
                        </div>

                        {importError && (
                            <div className='workbench-alert-error mb-4'>
                                {importError}
                            </div>
                        )}

                        {conflict && (
                            <div className='workbench-note mb-4'>
                                <p>{conflict}</p>
                                <div className='mt-3 flex flex-wrap gap-2'>
                                    <button
                                        type='button'
                                        disabled={busy}
                                        onClick={() =>
                                            void runImport('overwrite')
                                        }
                                        className='workbench-button-secondary h-8 px-3'
                                    >
                                        {t(
                                            'web.skills.library.conflictOverwrite'
                                        )}
                                    </button>
                                    <button
                                        type='button'
                                        disabled={busy}
                                        onClick={() => void runImport('rename')}
                                        className='workbench-button-secondary h-8 px-3'
                                    >
                                        {t('web.skills.library.conflictRename')}
                                    </button>
                                </div>
                            </div>
                        )}

                        {view.preview.skill.files.length > 0 && (
                            <div className='settings-card mb-4 px-4 py-3'>
                                <p className='text-caption text-subtle mb-1.5 font-medium'>
                                    {t('web.skills.shared.filesTitle', {
                                        count: view.preview.skill.files.length
                                    })}
                                </p>
                                <ul className='text-caption text-muted space-y-0.5 font-mono'>
                                    {view.preview.skill.files.map((file) => (
                                        <li
                                            key={file.path}
                                            className='truncate'
                                        >
                                            {file.path}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        <div className='workbench-panel overflow-x-auto px-5 py-4'>
                            <MarkdownText text={view.preview.skill.content} />
                        </div>
                    </>
                )}
            </div>
        </div>
    )
}

export default SharedSkill
