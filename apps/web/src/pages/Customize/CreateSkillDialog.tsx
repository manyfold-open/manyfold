import type {
    LibrarySkillDetail,
    LibrarySkillImportConflict
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useRef, useState } from 'react'
import { ApiError } from '@manyfold/sdk'
import ProductDialog from '@/components/ProductDialog'
import { UploadIcon } from '@/components/icons'
import { Spinner } from '@/components/Loading'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorDetailMessage, apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'

type CreateMethod = 'manual' | 'url' | 'upload'

const METHODS: CreateMethod[] = ['manual', 'url', 'upload']

const METHOD_LABEL_KEY: Record<CreateMethod, string> = {
    manual: 'web.skills.library.methodManual',
    url: 'web.skills.library.methodUrl',
    upload: 'web.skills.library.methodUpload'
}

// Name conflicts arrive as 409 with the existing skill under
// error.details (surfaced as ApiError.details); older responses carried
// only the message, so callers fall back to it when this returns null.
export const importConflictName = (err: unknown): string | null => {
    if (!(err instanceof ApiError) || err.status !== 409) return null
    const details = err.details as
        | { existingSkill?: { name?: unknown } }
        | undefined
    const name = details?.existingSkill?.name
    return typeof name === 'string' && name ? name : null
}

interface Props {
    onClose: () => void
    onCreated: (skill: LibrarySkillDetail) => void
}

const CreateSkillDialog: FC<Props> = ({ onClose, onCreated }): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const fileInputRef = useRef<HTMLInputElement | null>(null)
    const [method, setMethod] = useState<CreateMethod>('manual')
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [url, setUrl] = useState('')
    const [file, setFile] = useState<File | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [conflict, setConflict] = useState<string | null>(null)

    const switchMethod = (next: CreateMethod): void => {
        if (busy) return
        setMethod(next)
        setError(null)
        setConflict(null)
    }

    const runImport = async (
        onConflict?: LibrarySkillImportConflict
    ): Promise<void> => {
        setBusy(true)
        setError(null)
        setConflict(null)
        try {
            const result =
                method === 'upload' && file
                    ? await client.skills.library.importArchive(
                          file,
                          file.name,
                          onConflict ? { onConflict } : undefined
                      )
                    : await client.skills.library.import({
                          url: url.trim(),
                          onConflict
                      })
            onCreated(result.skill)
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
                setError(apiErrorDetailMessage(err))
            }
        } finally {
            setBusy(false)
        }
    }

    const submit = async (): Promise<void> => {
        if (busy) return
        if (method === 'manual') {
            if (!name.trim()) return
            setBusy(true)
            setError(null)
            try {
                const skill = await client.skills.library.create({
                    name: name.trim(),
                    description: description.trim() || undefined
                })
                onCreated(skill)
            } catch (err) {
                setError(apiErrorMessage(err))
            } finally {
                setBusy(false)
            }
            return
        }
        if (method === 'url' && !url.trim()) return
        if (method === 'upload' && !file) return
        await runImport()
    }

    const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault()
        void submit()
    }

    const submitDisabled =
        busy ||
        (method === 'manual'
            ? !name.trim()
            : method === 'url'
              ? !url.trim()
              : !file)

    return (
        <ProductDialog
            title={t('web.skills.library.createTitle')}
            onClose={onClose}
            onSubmit={onSubmit}
            closeDisabled={busy}
            footer={
                <>
                    <button
                        type='button'
                        onClick={onClose}
                        disabled={busy}
                        className='workbench-button-secondary'
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        type='submit'
                        disabled={submitDisabled}
                        className='workbench-button-primary'
                    >
                        {busy ? (
                            <>
                                <Spinner size={16} className='mr-2' />
                                {t('common.creating')}
                            </>
                        ) : (
                            t(
                                method === 'manual'
                                    ? 'web.skills.library.createAction'
                                    : 'web.skills.library.importAction'
                            )
                        )}
                    </button>
                </>
            }
        >
            <div className='bg-soft shadow-ring-light mb-4 inline-flex gap-1 rounded-md p-1'>
                {METHODS.map((item) => (
                    <button
                        key={item}
                        type='button'
                        disabled={busy}
                        onClick={() => switchMethod(item)}
                        className={[
                            'text-ui inline-flex h-9 items-center rounded-sm px-3.5 font-medium transition-colors',
                            method === item
                                ? 'bg-surface text-fg shadow-ring-light'
                                : 'text-muted hover:bg-surface-hover'
                        ].join(' ')}
                    >
                        {t(METHOD_LABEL_KEY[item])}
                    </button>
                ))}
            </div>

            {error && <div className='workbench-alert-error mb-4'>{error}</div>}

            {conflict && (
                <div className='workbench-note mb-4'>
                    <p>{conflict}</p>
                    <div className='mt-3 flex flex-wrap gap-2'>
                        <button
                            type='button'
                            disabled={busy}
                            onClick={() => void runImport('overwrite')}
                            className='workbench-button-secondary h-8 px-3'
                        >
                            {t('web.skills.library.conflictOverwrite')}
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

            {method === 'manual' && (
                <div className='space-y-4'>
                    <div>
                        <label className='workbench-field-label'>
                            {t('web.skills.library.nameLabel')}
                        </label>
                        <input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            disabled={busy}
                            className='workbench-input'
                            autoFocus
                        />
                    </div>
                    <div>
                        <label className='workbench-field-label'>
                            {t('web.skills.library.descriptionLabel')}
                        </label>
                        <input
                            value={description}
                            onChange={(event) =>
                                setDescription(event.target.value)
                            }
                            disabled={busy}
                            className='workbench-input'
                        />
                    </div>
                </div>
            )}

            {method === 'url' && (
                <div>
                    <label className='workbench-field-label'>
                        {t('web.skills.library.urlLabel')}
                    </label>
                    <input
                        value={url}
                        onChange={(event) => setUrl(event.target.value)}
                        disabled={busy}
                        placeholder='https://github.com/owner/repo'
                        className='workbench-input'
                        autoFocus
                    />
                    <p className='workbench-hint'>
                        {t('web.skills.library.urlHint')}
                    </p>
                </div>
            )}

            {method === 'upload' && (
                <div>
                    <label className='workbench-field-label'>
                        {t('web.skills.library.uploadLabel')}
                    </label>
                    <input
                        ref={fileInputRef}
                        type='file'
                        accept='.skill,.zip'
                        className='hidden'
                        onChange={(event) =>
                            setFile(event.target.files?.[0] ?? null)
                        }
                    />
                    <button
                        type='button'
                        disabled={busy}
                        onClick={() => fileInputRef.current?.click()}
                        className='border-divider text-ui text-muted hover:bg-surface-hover flex h-24 w-full flex-col items-center justify-center gap-1.5 rounded-sm border border-dashed transition-colors disabled:cursor-not-allowed disabled:opacity-50'
                    >
                        <UploadIcon className='h-4 w-4' />
                        {file ? (
                            <span className='text-fg max-w-full truncate px-4 font-mono'>
                                {file.name}
                            </span>
                        ) : (
                            <span>
                                {t('web.skills.library.uploadChoose')}
                            </span>
                        )}
                    </button>
                </div>
            )}
        </ProductDialog>
    )
}

export default CreateSkillDialog
