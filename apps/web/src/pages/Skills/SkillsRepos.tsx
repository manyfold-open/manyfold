import type { SkillRepoSummary } from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'

const SkillsRepos: FC = (): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [repos, setRepos] = useState<SkillRepoSummary[]>([])
    const [owner, setOwner] = useState('')
    const [name, setName] = useState('')
    const [branch, setBranch] = useState('main')
    const [busyId, setBusyId] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    const refresh = async (): Promise<void> => {
        try {
            setRepos(await client.skills.repos.list())
            setError(null)
        } catch (err) {
            setError(apiErrorMessage(err))
        }
    }

    useEffect(() => {
        void refresh()
    }, [client])

    const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault()
        setError(null)
        setBusyId('new')
        try {
            await client.skills.repos.create({ owner, name, branch })
            setOwner('')
            setName('')
            setBranch('main')
            await refresh()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusyId(null)
        }
    }

    const toggle = async (repo: SkillRepoSummary): Promise<void> => {
        setBusyId(repo.id)
        setError(null)
        try {
            const updated = await client.skills.repos.update(repo.id, {
                enabled: !repo.enabled
            })
            setRepos((prev) =>
                prev.map((item) => (item.id === updated.id ? updated : item))
            )
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusyId(null)
        }
    }

    const remove = async (repo: SkillRepoSummary): Promise<void> => {
        setBusyId(repo.id)
        setError(null)
        try {
            await client.skills.repos.delete(repo.id)
            setRepos((prev) => prev.filter((item) => item.id !== repo.id))
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusyId(null)
        }
    }

    return (
        <>
            <header className='mb-6'>
                <h1 className='text-h2 text-fg tracking-tight'>
                    {t('web.skills.reposTab')}
                </h1>
                <p className='text-ui text-muted mt-1'>
                    {t('web.skills.reposSubtitle')}
                </p>
            </header>

            {error && <div className='workbench-alert-error mb-5'>{error}</div>}

            <form
                onSubmit={submit}
                className='settings-card mb-6 grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_160px_auto]'
            >
                <input
                    value={owner}
                    onChange={(event) => setOwner(event.target.value)}
                    disabled={busyId === 'new'}
                    className='workbench-input'
                    placeholder={t('web.skills.ownerPlaceholder')}
                    required
                />
                <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={busyId === 'new'}
                    className='workbench-input'
                    placeholder={t('web.skills.repoPlaceholder')}
                    required
                />
                <input
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    disabled={busyId === 'new'}
                    className='workbench-input'
                    placeholder={t('web.skills.branchPlaceholder')}
                    required
                />
                <button
                    type='submit'
                    disabled={busyId === 'new'}
                    className='workbench-button-primary'
                >
                    {t('web.skills.addRepoAction')}
                </button>
            </form>

            <div className='settings-card'>
                {repos.map((repo) => (
                    <div key={repo.id} className='settings-card-row'>
                        <div className='min-w-0'>
                            <div className='settings-card-label'>
                                {repo.owner}/{repo.name}
                            </div>
                            <div className='settings-card-copy'>
                                <span className='font-mono'>{repo.branch}</span>
                                <span> · </span>
                                <span>
                                    {repo.readonly
                                        ? t('web.skills.builtinRepo')
                                        : t('web.skills.customRepo')}
                                </span>
                                <span> · </span>
                                <span>
                                    {repo.enabled
                                        ? t('web.skills.enabled')
                                        : t('web.skills.disabled')}
                                </span>
                            </div>
                        </div>
                        <div className='settings-card-side'>
                            {!repo.readonly && (
                                <>
                                    <button
                                        type='button'
                                        disabled={busyId === repo.id}
                                        onClick={() => void toggle(repo)}
                                        className='workbench-button-secondary'
                                    >
                                        {repo.enabled
                                            ? t('web.skills.disableAction')
                                            : t('web.skills.enableAction')}
                                    </button>
                                    <button
                                        type='button'
                                        disabled={busyId === repo.id}
                                        onClick={() => void remove(repo)}
                                        className='workbench-button-danger'
                                    >
                                        {t('web.skills.removeRepoAction')}
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </>
    )
}

export default SkillsRepos
