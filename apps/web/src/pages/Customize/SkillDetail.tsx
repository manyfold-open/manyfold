import type {
    DiscoverableSkillSummary,
    SkillReadmeDocument,
    SkillReadmeResponse,
    SkillReadmeSource
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError } from '@manyfold/sdk'
import EmptyState from '@/components/EmptyState'
import { GhostCatalogDetail, Spinner } from '@/components/Loading'
import { useLoadingGate } from '@/components/useLoadingGate'
import { Tag } from '@/components/Tag'
import MarkdownText from '@/components/chat/MarkdownText'
import {
    ArrowLeftIcon,
    DownloadIcon,
    ExternalLinkIcon,
    HistoryIcon,
    ShieldAlertIcon,
    SkillsIcon,
    SparklesIcon,
    UserIcon
} from '@/components/icons'
import { GithubMono } from '@/lib/brandIcons'
import { useApiClient } from '@/lib/apiClient'
import { formatDate as formatDateLocalized } from '@/lib/dateFormat'
import { apiErrorDetailMessage, apiErrorMessage } from '@/lib/errorMessage'
import { githubAvatarUrl } from '@/lib/githubAvatar'
import { useI18n } from '@/lib/i18n'
import InstallSkillDialog from './InstallSkillDialog'

// '' (not the lib's '—' placeholder) drives the neverUpdated fallback, and
// epoch-0 is the platform's "no real timestamp" sentinel.
const formatDate = (iso: string): string =>
    new Date(iso).getTime() > 0 ? formatDateLocalized(iso, '') : ''

const hostnameOf = (url: string): string => {
    try {
        return new URL(url).hostname
    } catch {
        return url
    }
}

// The tab label is the literal filename (SKILL.md / README.md) so the reader
// always knows which file the shown content comes from.
const docFilename = (path: string): string => path.split('/').pop() || path

const docSourceOf = (path: string): SkillReadmeSource =>
    /SKILL\.md$/i.test(path) ? 'skill' : 'readme'

const SkillDetail: FC = (): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const navigate = useNavigate()
    const [searchParams] = useSearchParams()
    const skillId = searchParams.get('id') ?? ''
    const [skill, setSkill] = useState<DiscoverableSkillSummary | null>(null)
    const [readme, setReadme] = useState<SkillReadmeResponse | null>(null)
    const [readmeMissing, setReadmeMissing] = useState(false)
    const [activeSource, setActiveSource] = useState<SkillReadmeSource | null>(
        null
    )
    const [loading, setLoading] = useState(true)
    const gate = useLoadingGate(loading)
    const [error, setError] = useState<string | null>(null)
    const [installOpen, setInstallOpen] = useState(false)
    const [copying, setCopying] = useState(false)
    const [copyError, setCopyError] = useState<string | null>(null)
    const [iconFailed, setIconFailed] = useState(false)

    const copyToLibrary = async (): Promise<void> => {
        if (!skill || copying) return
        setCopying(true)
        setCopyError(null)
        try {
            const result = await client.skills.library.import({
                catalogSkillId: skill.skillId
            })
            navigate(
                `/skills/library/edit?id=${encodeURIComponent(result.skill.id)}`
            )
        } catch (err) {
            setCopyError(
                err instanceof ApiError && err.status === 409
                    ? apiErrorDetailMessage(err)
                    : apiErrorMessage(err)
            )
        } finally {
            setCopying(false)
        }
    }

    useEffect(() => {
        if (!skillId) {
            setLoading(false)
            return
        }
        let cancelled = false
        setLoading(true)
        setSkill(null)
        setReadme(null)
        setReadmeMissing(false)
        setActiveSource(null)
        setIconFailed(false)
        setInstallOpen(false)
        setCopyError(null)
        // Clear a prior skill's error so it can't linger over the new load.
        setError(null)
        client.skills
            .detail(skillId)
            .then((item) => {
                if (cancelled) return
                setSkill(item)
                setError(null)
            })
            .catch((err: unknown) => {
                if (cancelled) return
                if (err instanceof ApiError && err.status === 404) {
                    setError(null)
                    return
                }
                setError(apiErrorMessage(err))
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        // The readme only needs the catalog skill id (== the URL id), so it
        // fetches in parallel with the detail instead of waiting a roundtrip.
        client.skills
            .readme(skillId)
            .then((res) => {
                if (!cancelled) setReadme(res)
            })
            .catch(() => {
                // best-effort — the external GitHub link still covers this
                if (!cancelled) setReadmeMissing(true)
            })
        return () => {
            cancelled = true
        }
    }, [client, skillId])

    const meta = readme?.meta
    const updated = skill ? formatDate(skill.updatedAt) : ''
    // Only documents with renderable prose become tabs: a frontmatter-only
    // SKILL.md (empty body) still feeds the sidebar meta but has nothing to
    // show here, so it drops out and the README (if any) carries the content.
    // The single-doc fallback covers an API response that predates `documents`
    // without reviving empty bodies.
    const documents: SkillReadmeDocument[] = (
        readme
            ? readme.documents?.length
                ? readme.documents
                : [
                      {
                          source: docSourceOf(readme.path),
                          path: readme.path,
                          content: readme.content,
                          body: readme.body ?? readme.content
                      }
                  ]
            : []
    ).filter((doc) => doc.body.trim().length > 0)
    const activeDoc =
        documents.find((doc) => doc.source === activeSource) ??
        documents[0] ??
        null
    const hasMetaInfo = Boolean(
        meta && (meta.version || meta.license || meta.platforms.length > 0)
    )

    return (
        <>
            <header className='mb-6'>
                <Link
                    to='/skills'
                    className='text-caption text-muted hover:text-fg inline-flex items-center gap-1.5 transition-colors'
                >
                    <ArrowLeftIcon className='h-3.5 w-3.5' />
                    {t('web.customize.backToSkills')}
                </Link>
            </header>

            {error && <div className='workbench-alert-error mb-5'>{error}</div>}

            {gate.showLoading && <GhostCatalogDetail aside={true} />}

            {!loading && !gate.showLoading && !skill && !error && (
                <EmptyState
                    kind='no-results'
                    tier='stack'
                    title={t('web.customize.skillNotFoundTitle')}
                    body={t('web.customize.skillNotFoundBody')}
                />
            )}

            {!loading && !gate.showLoading && skill && (
                <>
                    {copyError && (
                        <div className='workbench-alert-error mb-5'>
                            {copyError}
                        </div>
                    )}

                    <div className='mb-6 flex items-start gap-4'>
                        <div className='bg-soft text-subtle shadow-ring-light flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-sm'>
                            {!iconFailed ? (
                                <img
                                    src={githubAvatarUrl(skill.repoOwner)}
                                    alt=''
                                    className='h-full w-full object-cover'
                                    onError={() => setIconFailed(true)}
                                />
                            ) : (
                                <SkillsIcon className='h-6 w-6' />
                            )}
                        </div>
                        <div className='min-w-0 flex-1'>
                            <div className='flex flex-wrap items-center gap-2.5'>
                                <h1 className='text-h1 text-fg'>
                                    {skill.name}
                                </h1>
                                {skill.featured && (
                                    <Tag>
                                        <SparklesIcon className='h-3 w-3' />
                                        {t('web.customize.featuredBadge')}
                                    </Tag>
                                )}
                            </div>
                            {skill.description && (
                                <p className='text-body text-muted mt-1.5 max-w-[68ch] text-pretty'>
                                    {skill.description}
                                </p>
                            )}
                            <div className='text-caption text-subtle mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5'>
                                {skill.installCount > 0 && (
                                    <span className='inline-flex items-center gap-1.5'>
                                        <DownloadIcon className='h-3.5 w-3.5' />
                                        <span className='text-muted font-medium tabular-nums'>
                                            {t('web.customize.installCount', {
                                                count: skill.installCount
                                            })}
                                        </span>
                                    </span>
                                )}
                                <span className='inline-flex items-center gap-1.5'>
                                    <HistoryIcon className='h-3.5 w-3.5' />
                                    {updated
                                        ? t('web.skills.library.updatedOn', {
                                              date: updated
                                          })
                                        : t('web.customize.neverUpdated')}
                                </span>
                                {meta?.author && (
                                    <span className='inline-flex items-center gap-1.5'>
                                        <UserIcon className='h-3.5 w-3.5' />
                                        {meta.author}
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className='grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]'>
                        <main className='settings-card p-6 sm:p-8'>
                            {activeDoc ? (
                                <>
                                    <div className='border-divider/60 mb-6 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-b pb-3'>
                                        {documents.map((doc) => {
                                            const active =
                                                doc.source === activeDoc.source
                                            // A lone document is a static source
                                            // label, not a switch; only render a
                                            // real button when there's another
                                            // file to switch to.
                                            if (documents.length === 1)
                                                return (
                                                    <span
                                                        key={doc.source}
                                                        className='text-ui text-fg font-medium'
                                                    >
                                                        {docFilename(doc.path)}
                                                    </span>
                                                )
                                            return (
                                                <button
                                                    key={doc.source}
                                                    type='button'
                                                    aria-current={
                                                        active
                                                            ? 'true'
                                                            : undefined
                                                    }
                                                    onClick={() =>
                                                        setActiveSource(
                                                            doc.source
                                                        )
                                                    }
                                                    className={
                                                        active
                                                            ? 'text-ui text-fg font-medium'
                                                            : 'text-ui text-muted hover:text-fg font-normal transition-colors'
                                                    }
                                                >
                                                    {docFilename(doc.path)}
                                                </button>
                                            )
                                        })}
                                    </div>
                                    <div className='max-w-[72ch]'>
                                        <MarkdownText
                                            text={activeDoc.body}
                                            variant='doc'
                                        />
                                    </div>
                                </>
                            ) : readme || readmeMissing ? (
                                <EmptyState
                                    kind='no-results'
                                    tier='line'
                                    title={t('web.customize.readmeMissing')}
                                />
                            ) : (
                                <div className='workbench-note'>
                                    {t('common.loading')}
                                </div>
                            )}
                        </main>

                        <aside className='flex flex-col gap-4 lg:sticky lg:top-6'>
                            <div className='settings-card p-4'>
                                <button
                                    type='button'
                                    onClick={() => setInstallOpen(true)}
                                    className='workbench-button-primary w-full justify-center gap-1.5'
                                >
                                    <DownloadIcon className='h-4 w-4' />
                                    {t('web.customize.installToAgent')}
                                </button>
                                <button
                                    type='button'
                                    disabled={copying}
                                    onClick={() => void copyToLibrary()}
                                    className='workbench-button-secondary mt-2 w-full justify-center'
                                >
                                    {copying ? (
                                        <>
                                            <Spinner
                                                size={16}
                                                className='mr-2'
                                            />
                                            {t('common.copying')}
                                        </>
                                    ) : (
                                        t('web.skills.library.copyToLibrary')
                                    )}
                                </button>
                                <p className='text-caption text-subtle mt-3 leading-relaxed'>
                                    {t('web.customize.installHint')}
                                </p>
                                {skill.readmeUrl && (
                                    <a
                                        href={skill.readmeUrl}
                                        target='_blank'
                                        rel='noreferrer'
                                        className='border-divider/60 text-caption text-muted hover:text-fg mt-3 flex items-center gap-1.5 border-t pt-3 font-medium transition-colors'
                                    >
                                        <GithubMono size={14} />
                                        {t('web.customize.viewSourceOnGithub')}
                                        <ExternalLinkIcon className='ml-auto h-3 w-3' />
                                    </a>
                                )}
                            </div>

                            {meta && meta.secrets.length > 0 && (
                                <div className='bg-warning-bg shadow-ring-light rounded-md p-4'>
                                    <div className='text-warning-strong text-caption mb-2 flex items-center gap-1.5 font-medium uppercase tracking-wide'>
                                        <ShieldAlertIcon className='h-3.5 w-3.5' />
                                        {t('web.customize.requirementsTitle')}
                                    </div>
                                    <p className='text-caption text-fg mb-2'>
                                        {t('web.customize.requirementsIntro')}
                                    </p>
                                    <div className='flex flex-col gap-2.5'>
                                        {meta.secrets.map((secret, i) => (
                                            <div
                                                key={`${i}-${secret.envVar ?? ''}`}
                                            >
                                                {secret.prompt && (
                                                    <div className='text-caption text-fg'>
                                                        {secret.prompt}
                                                    </div>
                                                )}
                                                {secret.envVar && (
                                                    <code className='text-fg bg-tag-bg rounded-xs text-caption mt-0.5 inline-block break-all px-1.5 py-0.5 font-mono'>
                                                        {secret.envVar}
                                                    </code>
                                                )}
                                                {secret.providerUrl && (
                                                    <a
                                                        href={
                                                            secret.providerUrl
                                                        }
                                                        target='_blank'
                                                        rel='noreferrer'
                                                        className='text-warning-strong hover:text-warning text-caption mt-1 inline-flex items-center gap-1'
                                                    >
                                                        {t(
                                                            'web.customize.createSecretAt',
                                                            {
                                                                provider:
                                                                    hostnameOf(
                                                                        secret.providerUrl
                                                                    )
                                                            }
                                                        )}
                                                        <ExternalLinkIcon className='h-3 w-3' />
                                                    </a>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {hasMetaInfo && meta && (
                                <div className='settings-card p-4'>
                                    <div className='settings-card-label mb-2.5'>
                                        {t('web.customize.infoTitle')}
                                    </div>
                                    <dl className='flex flex-col'>
                                        <MetaRow
                                            label={t(
                                                'web.customize.metaVersion'
                                            )}
                                            value={
                                                meta.version
                                                    ? `v${meta.version}`
                                                    : null
                                            }
                                            mono
                                        />
                                        <MetaRow
                                            label={t(
                                                'web.customize.metaLicense'
                                            )}
                                            value={meta.license}
                                        />
                                        <MetaRow
                                            label={t(
                                                'web.customize.metaPlatforms'
                                            )}
                                            value={
                                                meta.platforms.length > 0
                                                    ? meta.platforms.join(' · ')
                                                    : null
                                            }
                                        />
                                    </dl>
                                </div>
                            )}

                            {(skill.category || skill.tags.length > 0) && (
                                <div className='settings-card p-4'>
                                    <div className='settings-card-label mb-2.5'>
                                        {t('web.customize.tagsTitle')}
                                    </div>
                                    <div className='flex flex-wrap gap-1.5'>
                                        {skill.category && (
                                            <Tag>{skill.category.name}</Tag>
                                        )}
                                        {skill.tags.map((tag) => (
                                            <Tag key={tag}>{tag}</Tag>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </aside>
                    </div>

                    {installOpen && (
                        <InstallSkillDialog
                            skill={skill}
                            onClose={() => setInstallOpen(false)}
                        />
                    )}
                </>
            )}
        </>
    )
}

const MetaRow: FC<{
    label: string
    value: string | null
    mono?: boolean
}> = ({ label, value, mono }) => {
    if (!value) return null
    return (
        <div className='border-divider/60 flex items-baseline justify-between gap-3 border-t py-1.5 first:border-t-0 first:pt-0'>
            <dt className='text-caption text-muted shrink-0'>{label}</dt>
            <dd
                className={`text-fg min-w-0 text-right font-medium ${mono ? 'text-caption font-mono font-normal' : 'text-ui'}`}
            >
                {value}
            </dd>
        </div>
    )
}

export default SkillDetail
