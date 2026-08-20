import type { FilesClient } from '@manyfold/sdk'

// Fetch a file from an agent's file root and trigger a browser download.
export const downloadFile = async (
    filesApi: FilesClient,
    agentId: string,
    rootId: string,
    absPath: string,
    filename: string
): Promise<void> => {
    const res = await filesApi.read(agentId, absPath, { rootId })
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
