import type {
    K8sClusterSummary,
    UpsertK8sClusterBody
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

const ClusterForm: FC = (): ReactNode => {
    const { id } = useParams<{ id?: string }>()
    const isEdit = Boolean(id)
    const client = useApiClient()
    const navigate = useNavigate()

    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [hostSuffix, setHostSuffix] = useState('')
    const [region, setRegion] = useState('')
    const [kubeconfig, setKubeconfig] = useState('')
    const [priority, setPriority] = useState('0')
    const [loading, setLoading] = useState(isEdit)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [loaded, setLoaded] = useState<K8sClusterSummary | null>(null)

    useEffect(() => {
        if (!id) return
        setLoading(true)
        client.admin.clusters
            .get(id)
            .then((row) => {
                setLoaded(row)
                setName(row.name)
                setDescription(row.description ?? '')
                setHostSuffix(row.hostSuffix ?? '')
                setRegion(row.region ?? '')
                setPriority(String(row.priority))
            })
            .catch((e: Error) => setError(e.message))
            .finally(() => setLoading(false))
    }, [client, id])

    const canSubmit =
        !submitting &&
        name.trim().length > 0 &&
        (isEdit || kubeconfig.trim().length > 0)

    const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
        e.preventDefault()
        setError(null)
        setSubmitting(true)
        try {
            const parsedPriority = Number.parseInt(priority, 10)
            const body: UpsertK8sClusterBody = {
                name: name.trim(),
                description: description.trim() || undefined,
                hostSuffix: hostSuffix.trim() || undefined,
                region: region.trim() || undefined,
                kubeconfig: kubeconfig.trim() || undefined,
                priority: Number.isFinite(parsedPriority) ? parsedPriority : 0
            }
            if (id) {
                await client.admin.clusters.update(id, body)
            } else {
                await client.admin.clusters.create(body)
            }
            navigate(adminRoutes.clusters)
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
                        label: t('admin.nav.clusters'),
                        to: adminRoutes.clusters
                    },
                    {
                        label: isEdit
                            ? (loaded?.name ??
                              id ??
                              t('admin.clusters.form.titleEdit'))
                            : t('admin.clusters.form.titleCreate')
                    }
                ]}
            />
            <Heading level={2} className='mb-2'>
                {isEdit
                    ? t('admin.clusters.form.titleEdit')
                    : t('admin.clusters.form.titleCreate')}
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
                                id='name'
                                label={t('admin.clusters.form.nameLabel')}
                                placeholder={t(
                                    'admin.clusters.form.namePlaceholder'
                                )}
                                hint={t('admin.clusters.form.nameHint')}
                                required
                                minLength={1}
                                maxLength={64}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />

                            <Input
                                id='description'
                                label={t(
                                    'admin.clusters.form.descriptionLabel'
                                )}
                                hint={t('admin.clusters.form.descriptionHint')}
                                maxLength={512}
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                            />

                            <Input
                                id='hostSuffix'
                                label={t('admin.clusters.form.hostSuffixLabel')}
                                hint={t('admin.clusters.form.hostSuffixHint')}
                                placeholder='apps.example.com'
                                maxLength={255}
                                value={hostSuffix}
                                onChange={(e) => setHostSuffix(e.target.value)}
                            />

                            <Input
                                id='region'
                                label='Region'
                                hint='Region slug used to route container SKU purchases to this cluster. Must match the region value chosen on Container SKUs (lowercase, dashes allowed, e.g. us-east-1, london).'
                                placeholder='us-east-1'
                                maxLength={64}
                                pattern='[a-z0-9][a-z0-9-]*'
                                value={region}
                                onChange={(e) => setRegion(e.target.value)}
                            />

                            <Input
                                id='priority'
                                type='number'
                                label='Priority'
                                hint='Higher wins when picking a default cluster within Persistent Runtime category. Range -1000..1000.'
                                min={-1000}
                                max={1000}
                                step={1}
                                value={priority}
                                onChange={(e) => setPriority(e.target.value)}
                            />

                            <div>
                                <label
                                    htmlFor='kubeconfig'
                                    className='text-caption text-label mb-1 block font-normal'
                                >
                                    {t('admin.clusters.form.kubeconfigLabel')}
                                </label>
                                <textarea
                                    id='kubeconfig'
                                    className='border-border text-caption text-heading placeholder:text-body/50 focus:border-brand focus:ring-brand block w-full rounded border bg-white px-3 py-2 font-mono focus:ring-1 focus:outline-none'
                                    rows={16}
                                    value={kubeconfig}
                                    onChange={(e) =>
                                        setKubeconfig(e.target.value)
                                    }
                                    placeholder={
                                        'apiVersion: v1\nclusters:\n  - cluster:\n      server: https://...\n      certificate-authority-data: ...'
                                    }
                                />
                                <p className='text-caption-sm text-body mt-1'>
                                    {isEdit
                                        ? t(
                                              'admin.clusters.form.kubeconfigHintEdit'
                                          )
                                        : t(
                                              'admin.clusters.form.kubeconfigHint'
                                          )}
                                </p>
                                {isEdit && loaded?.lastHealthMessage && (
                                    <p className='text-caption-sm text-body mt-2 font-mono'>
                                        Last probe: {loaded.lastHealthMessage}
                                    </p>
                                )}
                            </div>

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
                                    ? t('admin.clusters.form.submitting')
                                    : isEdit
                                      ? t('admin.clusters.form.submitUpdate')
                                      : t('admin.clusters.form.submitCreate')}
                            </Button>
                        </form>
                    )}
                </CardBody>
            </Card>
        </DetailPage>
    )
}

export default ClusterForm