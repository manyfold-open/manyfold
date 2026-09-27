import {
    runtimeProviderKinds,
    type CreateRuntimeProviderBody,
    type RuntimeProviderKind,
    type RuntimeProviderStatus,
    type RuntimeProviderSummary,
    type UpdateRuntimeProviderBody
} from '@manyfold/shared'
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

const textareaClass =
    'border-border text-caption text-heading focus:border-brand focus:ring-brand placeholder:text-body/50 block w-full rounded border bg-white px-3 py-2 font-mono focus:ring-1 focus:outline-none'

const selectClass =
    'border-border text-caption text-heading focus:border-brand focus:ring-brand block h-8 w-full rounded border bg-white px-2 focus:ring-1 focus:outline-none'

const configString = (
    config: Record<string, unknown>,
    key: string
): string => {
    const value = config[key]
    return typeof value === 'string' ? value : ''
}

// A sprites.dev token names its organization and token id in front of the
// secret; the form keeps those three parts in `config` so the list can show
// where the credential points without ever reading the secret back.
const parseSpritesCredential = (
    credential: string
): { orgSlug: string; orgId: string; tokenId: string } | null => {
    const parts = credential.trim().split('/')
    if (parts.length !== 4 || parts.some((part) => part.length === 0))
        return null
    return { orgSlug: parts[0], orgId: parts[1], tokenId: parts[2] }
}

const kindCardClass = (active: boolean): string =>
    [
        'flex cursor-pointer items-center gap-3 rounded border px-2 py-1.5 text-caption text-heading transition-colors',
        active
            ? 'border-brand bg-brand-subtle'
            : 'border-border bg-white hover:border-brand-light'
    ].join(' ')

const RuntimeProviderForm: FC = (): ReactNode => {
    const { id } = useParams<{ id?: string }>()
    const isEdit = Boolean(id)
    const client = useApiClient()
    const navigate = useNavigate()

    const [kind, setKind] = useState<RuntimeProviderKind>('sprites')
    const [name, setName] = useState('')
    const [status, setStatus] = useState<RuntimeProviderStatus>('enabled')
    const [priority, setPriority] = useState('0')
    const [region, setRegion] = useState('')
    const [credential, setCredential] = useState('')
    const [notes, setNotes] = useState('')
    const [description, setDescription] = useState('')
    const [hostSuffix, setHostSuffix] = useState('')
    const [loading, setLoading] = useState(isEdit)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [loaded, setLoaded] = useState<RuntimeProviderSummary | null>(null)

    useEffect(() => {
        if (!id) return
        setLoading(true)
        client.admin.runtimeProviders
            .get(id)
            .then((row) => {
                setLoaded(row)
                setKind(row.kind)
                setName(row.name)
                setStatus(row.status)
                setPriority(String(row.priority))
                setRegion(row.region ?? '')
                setNotes(configString(row.config, 'notes'))
                setDescription(configString(row.config, 'description'))
                setHostSuffix(configString(row.config, 'hostSuffix'))
            })
            .catch((e: Error) => setError(e.message))
            .finally(() => setLoading(false))
    }, [client, id])

    const parsedSprites =
        kind === 'sprites' && credential.trim().length > 0
            ? parseSpritesCredential(credential)
            : null
    const spritesOrg =
        parsedSprites ??
        (loaded && loaded.kind === 'sprites'
            ? {
                  orgSlug: configString(loaded.config, 'orgSlug'),
                  orgId: configString(loaded.config, 'orgId'),
                  tokenId: configString(loaded.config, 'tokenId')
              }
            : null)
    const credentialInvalid =
        kind === 'sprites' &&
        credential.trim().length > 0 &&
        parsedSprites === null

    const canSubmit =
        !submitting &&
        name.trim().length > 0 &&
        !credentialInvalid &&
        (isEdit || credential.trim().length > 0)

    const buildConfig = (): Record<string, unknown> => {
        if (kind === 'sprites') {
            const org =
                parsedSprites ??
                (loaded ? spritesOrg : null) ??
                ({ orgSlug: '', orgId: '', tokenId: '' } as const)
            return {
                orgSlug: org.orgSlug,
                orgId: org.orgId,
                tokenId: org.tokenId,
                notes: notes.trim() || null
            }
        }
        return {
            description: description.trim() || null,
            hostSuffix: hostSuffix.trim() || null
        }
    }

    const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
        e.preventDefault()
        setError(null)
        setSubmitting(true)
        try {
            const parsedPriority = Number.parseInt(priority, 10)
            const priorityValue = Number.isFinite(parsedPriority)
                ? parsedPriority
                : 0
            if (id) {
                const body: UpdateRuntimeProviderBody = {
                    name: name.trim(),
                    status,
                    priority: priorityValue,
                    region: region.trim() || null,
                    config: buildConfig()
                }
                if (credential.trim()) body.credential = credential.trim()
                await client.admin.runtimeProviders.update(id, body)
            } else {
                const body: CreateRuntimeProviderBody = {
                    kind,
                    name: name.trim(),
                    credential: credential.trim(),
                    priority: priorityValue,
                    config: buildConfig()
                }
                if (region.trim()) body.region = region.trim()
                await client.admin.runtimeProviders.create(body)
            }
            navigate(adminRoutes.runtimeProviders)
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <DetailPage>
            <Breadcrumbs
                items={[
                    {
                        label: t('admin.nav.runtimeProviders'),
                        to: adminRoutes.runtimeProviders
                    },
                    {
                        label: isEdit
                            ? (loaded?.name ??
                              id ??
                              t('admin.runtimeProviders.form.titleEdit'))
                            : t('admin.runtimeProviders.form.titleCreate')
                    }
                ]}
            />
            <Heading level={2} className='mb-2'>
                {isEdit
                    ? t('admin.runtimeProviders.form.titleEdit')
                    : t('admin.runtimeProviders.form.titleCreate')}
            </Heading>

            <Card elevation='elevated'>
                <CardBody>
                    {loading ? (
                        <p className='text-caption text-body'>
                            {t('common.loading')}
                        </p>
                    ) : (
                        <form onSubmit={submit} className='space-y-2'>
                            <div>
                                <span className='text-caption text-label mb-1 block font-normal'>
                                    {t('admin.runtimeProviders.form.kindLabel')}
                                </span>
                                {isEdit ? (
                                    <p className='text-caption text-heading'>
                                        {t(
                                            `admin.runtimeProviders.kind.${kind}`
                                        )}
                                    </p>
                                ) : (
                                    <div className='grid grid-cols-2 gap-3'>
                                        {runtimeProviderKinds.map((option) => (
                                            <label
                                                key={option}
                                                className={kindCardClass(
                                                    kind === option
                                                )}
                                            >
                                                <input
                                                    type='radio'
                                                    name='kind'
                                                    value={option}
                                                    checked={kind === option}
                                                    onChange={(): void => {
                                                        setKind(option)
                                                        setCredential('')
                                                    }}
                                                    className='accent-brand'
                                                />
                                                {t(
                                                    `admin.runtimeProviders.kind.${option}`
                                                )}
                                            </label>
                                        ))}
                                    </div>
                                )}
                                <p className='text-caption-sm text-body mt-1'>
                                    {t('admin.runtimeProviders.form.kindHint')}
                                </p>
                            </div>

                            <Input
                                id='name'
                                label={t('admin.runtimeProviders.form.nameLabel')}
                                placeholder={t(
                                    'admin.runtimeProviders.form.namePlaceholder'
                                )}
                                hint={t('admin.runtimeProviders.form.nameHint')}
                                required
                                minLength={1}
                                maxLength={64}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />

                            {isEdit && (
                                <div>
                                    <label
                                        htmlFor='status'
                                        className='text-caption text-label mb-1 block font-normal'
                                    >
                                        {t(
                                            'admin.runtimeProviders.form.statusLabel'
                                        )}
                                    </label>
                                    <select
                                        id='status'
                                        className={selectClass}
                                        value={status}
                                        onChange={(e): void =>
                                            setStatus(
                                                e.target
                                                    .value as RuntimeProviderStatus
                                            )
                                        }
                                    >
                                        <option value='enabled'>
                                            {t(
                                                'admin.runtimeProviders.status.enabled'
                                            )}
                                        </option>
                                        <option value='disabled'>
                                            {t(
                                                'admin.runtimeProviders.status.disabled'
                                            )}
                                        </option>
                                    </select>
                                </div>
                            )}

                            <Input
                                id='priority'
                                type='number'
                                label={t(
                                    'admin.runtimeProviders.form.priorityLabel'
                                )}
                                hint={t(
                                    'admin.runtimeProviders.form.priorityHint'
                                )}
                                min={-1000}
                                max={1000}
                                step={1}
                                value={priority}
                                onChange={(e) => setPriority(e.target.value)}
                            />

                            <Input
                                id='region'
                                label={t(
                                    'admin.runtimeProviders.form.regionLabel'
                                )}
                                hint={t('admin.runtimeProviders.form.regionHint')}
                                placeholder='us-east-1'
                                maxLength={64}
                                pattern='[a-z0-9][a-z0-9-]*'
                                value={region}
                                onChange={(e) => setRegion(e.target.value)}
                            />

                            {kind === 'sprites' ? (
                                <>
                                    <div>
                                        <label
                                            htmlFor='credential'
                                            className='text-caption text-label mb-1 block font-normal'
                                        >
                                            {t(
                                                'admin.runtimeProviders.form.spritesCredentialLabel'
                                            )}
                                        </label>
                                        <textarea
                                            id='credential'
                                            className={textareaClass}
                                            rows={3}
                                            required={!isEdit}
                                            maxLength={256}
                                            value={credential}
                                            onChange={(e) =>
                                                setCredential(e.target.value)
                                            }
                                            placeholder={t(
                                                'admin.runtimeProviders.form.spritesCredentialPlaceholder'
                                            )}
                                        />
                                        <p
                                            className={
                                                credentialInvalid
                                                    ? 'text-caption-sm text-accent-ruby mt-1'
                                                    : 'text-caption-sm text-body mt-1'
                                            }
                                        >
                                            {credentialInvalid
                                                ? t(
                                                      'admin.runtimeProviders.form.spritesCredentialInvalid'
                                                  )
                                                : isEdit
                                                  ? t(
                                                        'admin.runtimeProviders.form.spritesCredentialHintEdit'
                                                    )
                                                  : t(
                                                        'admin.runtimeProviders.form.spritesCredentialHint'
                                                    )}
                                        </p>
                                    </div>

                                    {spritesOrg && (
                                        <dl className='text-caption-sm text-body grid grid-cols-3 gap-2 font-mono'>
                                            <dt>
                                                {t(
                                                    'admin.runtimeProviders.form.orgSlugLabel'
                                                )}
                                            </dt>
                                            <dd className='col-span-2'>
                                                {spritesOrg.orgSlug || '—'}
                                            </dd>
                                            <dt>
                                                {t(
                                                    'admin.runtimeProviders.form.orgIdLabel'
                                                )}
                                            </dt>
                                            <dd className='col-span-2'>
                                                {spritesOrg.orgId || '—'}
                                            </dd>
                                            <dt>
                                                {t(
                                                    'admin.runtimeProviders.form.tokenIdLabel'
                                                )}
                                            </dt>
                                            <dd className='col-span-2'>
                                                {spritesOrg.tokenId || '—'}
                                            </dd>
                                        </dl>
                                    )}

                                    <div>
                                        <label
                                            htmlFor='notes'
                                            className='text-caption text-label mb-1 block font-normal'
                                        >
                                            {t(
                                                'admin.runtimeProviders.form.notesLabel'
                                            )}
                                        </label>
                                        <textarea
                                            id='notes'
                                            className={textareaClass}
                                            rows={3}
                                            maxLength={1024}
                                            value={notes}
                                            onChange={(e) =>
                                                setNotes(e.target.value)
                                            }
                                        />
                                        <p className='text-caption-sm text-body mt-1'>
                                            {t(
                                                'admin.runtimeProviders.form.notesHint'
                                            )}
                                        </p>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <Input
                                        id='description'
                                        label={t(
                                            'admin.runtimeProviders.form.descriptionLabel'
                                        )}
                                        hint={t(
                                            'admin.runtimeProviders.form.descriptionHint'
                                        )}
                                        maxLength={512}
                                        value={description}
                                        onChange={(e) =>
                                            setDescription(e.target.value)
                                        }
                                    />

                                    <Input
                                        id='hostSuffix'
                                        label={t(
                                            'admin.runtimeProviders.form.hostSuffixLabel'
                                        )}
                                        hint={t(
                                            'admin.runtimeProviders.form.hostSuffixHint'
                                        )}
                                        placeholder='apps.example.com'
                                        maxLength={255}
                                        value={hostSuffix}
                                        onChange={(e) =>
                                            setHostSuffix(e.target.value)
                                        }
                                    />

                                    <div>
                                        <label
                                            htmlFor='credential'
                                            className='text-caption text-label mb-1 block font-normal'
                                        >
                                            {t(
                                                'admin.runtimeProviders.form.kubeconfigLabel'
                                            )}
                                        </label>
                                        <textarea
                                            id='credential'
                                            className={textareaClass}
                                            rows={16}
                                            required={!isEdit}
                                            value={credential}
                                            onChange={(e) =>
                                                setCredential(e.target.value)
                                            }
                                            placeholder={
                                                'apiVersion: v1\nclusters:\n  - cluster:\n      server: https://...\n      certificate-authority-data: ...'
                                            }
                                        />
                                        <p className='text-caption-sm text-body mt-1'>
                                            {isEdit
                                                ? t(
                                                      'admin.runtimeProviders.form.kubeconfigHintEdit'
                                                  )
                                                : t(
                                                      'admin.runtimeProviders.form.kubeconfigHint'
                                                  )}
                                        </p>
                                    </div>
                                </>
                            )}

                            {isEdit && loaded?.lastHealthMessage && (
                                <p className='text-caption-sm text-body font-mono'>
                                    {t('admin.runtimeProviders.form.lastProbe', {
                                        message: loaded.lastHealthMessage
                                    })}
                                </p>
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
                                    ? t('admin.runtimeProviders.form.submitting')
                                    : isEdit
                                      ? t(
                                            'admin.runtimeProviders.form.submitUpdate'
                                        )
                                      : t(
                                            'admin.runtimeProviders.form.submitCreate'
                                        )}
                            </Button>
                        </form>
                    )}
                </CardBody>
            </Card>
        </DetailPage>
    )
}

export default RuntimeProviderForm
