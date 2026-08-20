import type { FilesClient } from '@manyfold/sdk'

export const downloadEntry = async (
    filesApi: FilesClient,
    agentId: string,
    path: string,
    rootId?: string
): Promise<void> => {
    const res = await filesApi.read(
        agentId,
        path,
        rootId ? { rootId } : undefined
    )
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = path.split('/').pop() ?? 'file'
    a.click()
    URL.revokeObjectURL(url)
}
