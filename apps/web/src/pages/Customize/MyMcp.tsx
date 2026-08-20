import type { UserMcpServer } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import EmptyState from '@/components/EmptyState'
import { GhostSettingsRows } from '@/components/Loading'
import { useLoadingGate } from '@/components/useLoadingGate'
import { McpIcon, PlusIcon } from '@/components/icons'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import UserAvatar from '@/components/UserAvatar'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { formatDate } from '@/lib/dateFormat'
import { useI18n } from '@/lib/i18n'
import { useCurrentUserAvatar } from '@/lib/useCurrentUserAvatar'
import CustomizePageHeader from './CustomizePageHeader'
import InstallMcpDialog from './InstallMcpDialog'
import UserMcpServerDialog from './UserMcpServerDialog'

const MyMcp: FC = (): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const navigate = useNavigate()
    const { confirm, confirmDialog } = useProductConfirm()
    const userAvatar = useCurrentUserAvatar()
    const [servers, setServers] = useState<UserMcpServer[]>([])
    const [loading, setLoading] = useState(true)
    const gate = useLoadingGate(loading)
    const [busyId, setBusyId] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [editing, setEditing] = useState<UserMcpServer | 'new' | null>(null)
    const [installing, setInstalling] = useState<UserMcpServer | null>(null)

    useEffect(() => {
        let cancelled = false
        client.mcp.library
            .list()
            .then((items) => {
                if (cancelled) return
                setServers(items)
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

    const saveServer = (server: UserMcpServer): void => {
        setServers((current) => {
            const exists = current.some((item) => item.id === server.id)
            const next = exists
                ? current.map((item) => (item.id === server.id ? server : item))
                : [...current, server]
            return next.sort((a, b) => a.name.localeCompare(b.name))
        })
        setEditing(null)
    }

    const removeServer = async (server: UserMcpServer): Promise<void> => {
        if (busyId) return
        const confirmed = await confirm({
            title: t('web.customize.myMcpDelete'),
            description: t('web.customize.myMcpDeleteConfirm', {
                name: server.name
            }),
            confirmLabel: t('web.customize.myMcpDelete'),
            cancelLabel: t('common.cancel'),
            tone: 'danger'
        })
        if (!confirmed) return
        setBusyId(server.id)
        setError(null)
        try {
            await client.mcp.library.delete(server.id)
            setServers((current) =>
                current.filter((item) => item.id !== server.id)
            )
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusyId(null)
        }
    }

    return (
        <>
            <CustomizePageHeader
                group='mcp'
                action={
                    <button
                        type='button'
                        onClick={() => setEditing('new')}
                        className='workbench-button-primary shrink-0 gap-1.5'
                    >
                        <PlusIcon className='h-4 w-4' />
                        {t('web.customize.myMcpNew')}
                    </button>
                }
            />

            {error && <div className='workbench-alert-error mb-5'>{error}</div>}

            {gate.showLoading && (
                <section className='settings-card' aria-busy='true'>
                    <GhostSettingsRows rows={3} />
                </section>
            )}

            {!loading &&
                !gate.showLoading &&
                servers.length === 0 &&
                !error && (
                    <EmptyState
                        kind='first-use'
                        tier='stack'
                        icon={McpIcon}
                        title={t('web.customize.myMcpEmptyTitle')}
                        body={t('web.customize.myMcpEmptyBody')}
                        action={{
                            label: t('web.customize.browseMcpCatalog'),
                            onClick: () => navigate('/mcp')
                        }}
                    />
                )}

            {!gate.showLoading && servers.length > 0 && (
                <section
                    className={
                        gate.fadeIn
                            ? 'settings-card loading-fade-in'
                            : 'settings-card'
                    }
                >
                    {servers.map((server) => (
                        <div key={server.id} className='settings-card-row'>
                            <div className='flex min-w-0 items-start gap-3'>
                                <UserAvatar
                                    imageUrl={userAvatar.imageUrl}
                                    label={userAvatar.label}
                                    className='h-8 w-8 text-[0.65rem]'
                                />
                                <div className='min-w-0'>
                                    <div className='settings-card-label'>
                                        {server.name}
                                    </div>
                                    {server.description && (
                                        <p className='settings-card-copy break-words'>
                                            {server.description}
                                        </p>
                                    )}
                                    <div className='text-caption text-muted mt-1.5 flex flex-wrap items-center gap-1.5'>
                                        <span className='tag tag-neutral font-mono'>
                                            {server.serverKey}
                                        </span>
                                        <span>·</span>
                                        <span>
                                            {t(
                                                server.transport === 'http'
                                                    ? 'web.customize.transportHttp'
                                                    : 'web.customize.transportStdio'
                                            )}
                                        </span>
                                        <span>·</span>
                                        <span>
                                            {formatDate(server.updatedAt)}
                                        </span>
                                    </div>
                                </div>
                            </div>
                            <div className='settings-card-side'>
                                <button
                                    type='button'
                                    onClick={() => setEditing(server)}
                                    className='workbench-button-secondary h-8 px-3'
                                >
                                    {t('web.customize.myMcpEdit')}
                                </button>
                                <button
                                    type='button'
                                    onClick={() => setInstalling(server)}
                                    className='workbench-button-secondary h-8 px-3'
                                >
                                    {t('web.customize.myMcpInstall')}
                                </button>
                                <button
                                    type='button'
                                    disabled={busyId === server.id}
                                    onClick={() => void removeServer(server)}
                                    className='workbench-button-danger h-8 px-3'
                                >
                                    {t('web.customize.myMcpDelete')}
                                </button>
                            </div>
                        </div>
                    ))}
                </section>
            )}

            {editing && (
                <UserMcpServerDialog
                    server={editing === 'new' ? undefined : editing}
                    onClose={() => setEditing(null)}
                    onSaved={saveServer}
                />
            )}

            {installing && (
                <InstallMcpDialog
                    entry={{
                        id: installing.serverKey,
                        name: installing.name,
                        transport: installing.transport,
                        url: installing.url,
                        headers: installing.headers,
                        command: installing.command,
                        args: installing.args,
                        env: installing.env
                    }}
                    onClose={() => setInstalling(null)}
                />
            )}

            {confirmDialog}
        </>
    )
}

export default MyMcp
