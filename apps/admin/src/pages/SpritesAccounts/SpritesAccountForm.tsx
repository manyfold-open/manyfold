import type { SdkSpritesAccountSummary } from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { t } from '@manyfold/i18n'
import { useApiClient } from '@/lib/apiClient'
import { adminRoutes } from '@/routes'
import {
    Breadcrumbs,
    Button,
    Card,
    CardBody,
    DetailPage,
    Heading,
    Input
} from '@/ui'

const SpritesAccountForm: FC = (): ReactNode => {
    const { slug: slugParam } = useParams<{ slug?: string }>()
    const isEdit = Boolean(slugParam)
    const client = useApiClient()
    const navigate = useNavigate()

    const [slug, setSlug] = useState('')
    const [token, setToken] = useState('')
    const [notes, setNotes] = useState('')
    const [priority, setPriority] = useState('0')
    const [rotateToken, setRotateToken] = useState('')
    const [loading, setLoading] = useState(isEdit)
    const [submitting, setSubmitting] = useState(false)
    const [rotating, setRotating] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [rotateMessage, setRotateMessage] = useState<string | null>(null)
    const [loaded, setLoaded] = useState<SdkSpritesAccountSummary | null>(null)

    useEffect(() => {
        if (!slugParam) return
        setLoading(true)
        client.admin.spritesAccounts
            .get(slugParam)
            .then((row) => {
                setLoaded(row)
                setSlug(row.slug)
                setNotes(row.notes ?? '')
                setPriority(String(row.priority))
            })
            .catch((e: Error) => setError(e.message))
            .finally(() => setLoading(false))
    }, [client, slugParam])

    const canSubmit = isEdit
        ? !submitting
        : !submitting && slug.trim().length > 0 && token.trim().length > 0

    const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
        e.preventDefault()
        setError(null)
        setSubmitting(true)
        try {
            const parsedPriority = Number.parseInt(priority, 10)
            const priorityValue = Number.isFinite(parsedPriority)
                ? parsedPriority
                : 0
            if (isEdit && slugParam) {
                await client.admin.spritesAccounts.update(slugParam, {
                    notes: notes.trim() || null,
                    priority: priorityValue
                })
            } else {
                await client.admin.spritesAccounts.create({
                    slug: slug.trim(),
                    token: token.trim(),
                    notes: notes.trim() || undefined,
                    priority: priorityValue
                })
            }
            navigate(adminRoutes.sandboxAccounts)
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setSubmitting(false)
        }
    }

    const submitRotate = async (
        e: FormEvent<HTMLFormElement>
    ): Promise<void> => {
        e.preventDefault()
        if (!slugParam) return
        setError(null)
        setRotateMessage(null)
        setRotating(true)
        try {
            await client.admin.spritesAccounts.rotate(
                slugParam,
                rotateToken.trim()
            )
            setRotateToken('')
            setRotateMessage(t('admin.spritesAccounts.form.rotateSuccess'))
            const fresh = await client.admin.spritesAccounts.get(slugParam)
            setLoaded(fresh)
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setRotating(false)
        }
    }

    return (
        <DetailPage>
            <Breadcrumbs
                items={[
                    {
                        label: t('admin.nav.spritesAccounts'),
                        to: adminRoutes.sandboxAccounts
                    },
                    {
                        label: isEdit
                            ? (loaded?.slug ??
                              slugParam ??
                              t('admin.spritesAccounts.form.titleEdit'))
                            : t('admin.spritesAccounts.form.titleCreate')
                    }
                ]}
            />
            <Heading level={2} className='mb-2'>
                {isEdit
                    ? t('admin.spritesAccounts.form.titleEdit')
                    : t('admin.spritesAccounts.form.titleCreate')}
            </Heading>

            <Card elevation='elevated'>
                <CardBody>
                    {loading ? (
                        <p className='text-caption text-body'>
                            {t('common.loading')}
                        </p>
                    ) : (
                        <form onSubmit={submit} className='space-y-2'>
                            <Input
                                id='slug'
                                label={t(
                                    'admin.spritesAccounts.form.slugLabel'
                                )}
                                placeholder={t(
                                    'admin.spritesAccounts.form.slugPlaceholder'
                                )}
                                hint={t('admin.spritesAccounts.form.slugHint')}
                                required={!isEdit}
                                readOnly={isEdit}
                                minLength={1}
                                maxLength={64}
                                pattern='[a-z0-9][a-z0-9_-]*'
                                value={slug}
                                onChange={(e) => setSlug(e.target.value)}
                            />

                            {!isEdit && (
                                <div>
                                    <label
                                        htmlFor='token'
                                        className='text-caption text-label mb-1 block font-normal'
                                    >
                                        {t(
                                            'admin.spritesAccounts.form.tokenLabel'
                                        )}
                                    </label>
                                    <textarea
                                        id='token'
                                        className='border-border text-caption text-heading focus:border-brand focus:ring-brand placeholder:text-body/50 block w-full rounded border bg-white px-3 py-2 font-mono focus:ring-1 focus:outline-none'
                                        rows={3}
                                        required
                                        minLength={16}
                                        maxLength={256}
                                        value={token}
                                        onChange={(e) =>
                                            setToken(e.target.value)
                                        }
                                        placeholder={t(
                                            'admin.spritesAccounts.form.tokenPlaceholder'
                                        )}
                                    />
                                    <p className='text-caption-sm text-body mt-1'>
                                        {t(
                                            'admin.spritesAccounts.form.tokenHint'
                                        )}
                                    </p>
                                </div>
                            )}

                            <div>
                                <label
                                    htmlFor='notes'
                                    className='text-caption text-label mb-1 block font-normal'
                                >
                                    {t('admin.spritesAccounts.form.notesLabel')}
                                </label>
                                <textarea
                                    id='notes'
                                    className='border-border text-caption text-heading focus:border-brand focus:ring-brand placeholder:text-body/50 block w-full rounded border bg-white px-3 py-2 focus:ring-1 focus:outline-none'
                                    rows={3}
                                    maxLength={1024}
                                    value={notes}
                                    onChange={(e) => setNotes(e.target.value)}
                                />
                                <p className='text-caption-sm text-body mt-1'>
                                    {t('admin.spritesAccounts.form.notesHint')}
                                </p>
                            </div>

                            <Input
                                id='priority'
                                type='number'
                                label='Priority'
                                hint='Higher wins when picking a default account within Stateful Sandbox category. Range -1000..1000.'
                                min={-1000}
                                max={1000}
                                step={1}
                                value={priority}
                                onChange={(e) => setPriority(e.target.value)}
                            />

                            {isEdit && loaded && (
                                <div className='text-caption-sm text-body'>
                                    <span className='mr-2 font-mono'>
                                        org: {loaded.orgSlug}
                                    </span>
                                    <span className='mr-2'>·</span>
                                    <span>
                                        {t(
                                            `admin.spritesAccounts.status.${loaded.status}`
                                        )}
                                    </span>
                                    <span className='mr-2'>·</span>
                                    <span>
                                        {loaded.activeSprites}{' '}
                                        {t(
                                            'admin.spritesAccounts.cols.activeSprites'
                                        )}
                                    </span>
                                </div>
                            )}

                            {error && (
                                <div className='border-accent-ruby/30 bg-accent-ruby/5 rounded border px-3 py-2'>
                                    <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                                        {error}
                                    </pre>
                                </div>
                            )}

                            <Button
                                type='submit'
                                variant='primary'
                                size='md'
                                disabled={!canSubmit}
                                className='w-full'
                            >
                                {submitting
                                    ? t('admin.spritesAccounts.form.submitting')
                                    : isEdit
                                      ? t(
                                            'admin.spritesAccounts.form.submitUpdate'
                                        )
                                      : t(
                                            'admin.spritesAccounts.form.submitCreate'
                                        )}
                            </Button>
                        </form>
                    )}
                </CardBody>
            </Card>

            {isEdit && !loading && (
                <Card elevation='elevated' className='mt-2'>
                    <CardBody>
                        <Heading level={3} className='mb-2'>
                            {t('admin.spritesAccounts.form.rotateTitle')}
                        </Heading>
                        <p className='text-caption-sm text-body mb-2'>
                            {t('admin.spritesAccounts.form.rotateHint')}
                        </p>
                        <form onSubmit={submitRotate} className='space-y-2'>
                            <textarea
                                id='rotateToken'
                                aria-label={t(
                                    'admin.spritesAccounts.form.rotateLabel'
                                )}
                                className='border-border text-caption text-heading focus:border-brand focus:ring-brand placeholder:text-body/50 block w-full rounded border bg-white px-3 py-2 font-mono focus:ring-1 focus:outline-none'
                                rows={3}
                                minLength={16}
                                maxLength={256}
                                value={rotateToken}
                                onChange={(e) => setRotateToken(e.target.value)}
                                placeholder={t(
                                    'admin.spritesAccounts.form.tokenPlaceholder'
                                )}
                            />
                            {rotateMessage && (
                                <p className='text-success-text text-caption-sm'>
                                    {rotateMessage}
                                </p>
                            )}
                            <Button
                                type='submit'
                                variant='neutral'
                                size='md'
                                disabled={
                                    rotating || rotateToken.trim().length < 16
                                }
                            >
                                {rotating
                                    ? t('admin.spritesAccounts.form.submitting')
                                    : t(
                                          'admin.spritesAccounts.form.submitRotate'
                                      )}
                            </Button>
                        </form>
                    </CardBody>
                </Card>
            )}
        </DetailPage>
    )
}

export default SpritesAccountForm