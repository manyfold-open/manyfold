import type { FileRootSdk } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import type { SdkAgent } from '@manyfold/sdk'
import { t } from '@manyfold/i18n'
import { useApiClient } from '@/lib/apiClient'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { FileBrowser } from './files/FileBrowser'

interface FilesTabProps {
    agent: SdkAgent
}

const DEFAULT_MOUNT = '/workspace'

const FilesTab: FC<FilesTabProps> = ({ agent }): ReactNode => {
    const client = useApiClient()
    const { isAdmin } = useCurrentUser()
    const filesApi = isAdmin ? client.admin.files : client.files
    const [roots, setRoots] = useState<FileRootSdk[] | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (agent.status !== 'running') return
        let cancelled = false
        filesApi
            .roots(agent.id)
            .then((res) => {
                if (cancelled) return
                setRoots(res.roots)
            })
            .catch((err) => {
                if (cancelled) return
                setError((err as Error).message)
            })
        return (): void => {
            cancelled = true
        }
    }, [filesApi, agent.id, agent.status])

    if (agent.status !== 'running')
        return (
            <p className='text-caption text-body'>
                {t('admin.agents.detail.files.unavailable')}
            </p>
        )

    if (error)
        return (
            <p className='text-caption-sm text-accent-ruby'>
                Failed to load file roots: {error}
            </p>
        )

    if (!roots) return <p className='text-caption text-body'>Loading…</p>

    const safeRoots: FileRootSdk[] =
        roots.length > 0
            ? roots
            : [
                  {
                      id: 'workspace',
                      label: 'Workspace',
                      path: agent.mountPath ?? DEFAULT_MOUNT,
                      writable: true
                  }
              ]

    return (
        <FileBrowser filesApi={filesApi} agentId={agent.id} roots={safeRoots} />
    )
}

export default FilesTab
