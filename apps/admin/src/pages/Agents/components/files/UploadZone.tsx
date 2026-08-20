import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import { useDropzone } from 'react-dropzone'
import type { FilesClient } from '@manyfold/sdk'

interface UploadZoneProps {
    filesApi: FilesClient
    agentId: string
    currentPath: string
    rootId?: string
    disabled?: boolean
    onComplete: () => void
    children: ReactNode
}

interface UploadItem {
    name: string
    total: number
    loaded: number
    error?: string
    done?: boolean
}

const joinPath = (dir: string, name: string): string => {
    if (dir === '/') return `/${name}`
    return `${dir.replace(/\/$/, '')}/${name}`
}

export const UploadZone: FC<UploadZoneProps> = ({
    filesApi,
    agentId,
    currentPath,
    rootId,
    disabled,
    onComplete,
    children
}): ReactNode => {
    const [queue, setQueue] = useState<UploadItem[]>([])

    const upload = async (files: File[]): Promise<void> => {
        setQueue(files.map((f) => ({ name: f.name, total: f.size, loaded: 0 })))
        for (let i = 0; i < files.length; i++) {
            const file = files[i]
            const target = joinPath(currentPath, file.name)
            try {
                await filesApi.write(agentId, target, file, {
                    rootId,
                    onProgress: (loaded, total) => {
                        setQueue((q) => {
                            const next = [...q]
                            next[i] = { ...next[i], loaded, total }
                            return next
                        })
                    }
                })
                setQueue((q) => {
                    const next = [...q]
                    next[i] = { ...next[i], done: true, loaded: file.size }
                    return next
                })
            } catch (err) {
                setQueue((q) => {
                    const next = [...q]
                    next[i] = { ...next[i], error: (err as Error).message }
                    return next
                })
            }
        }
        onComplete()
        setTimeout(() => setQueue([]), 2000)
    }

    const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
        noClick: true,
        noKeyboard: true,
        disabled,
        onDrop: (accepted) => {
            if (accepted.length > 0) void upload(accepted)
        }
    })

    return (
        <div
            {...getRootProps()}
            className='relative flex h-full min-h-0 flex-1 flex-col'
        >
            <input {...getInputProps()} />
            {children}
            {isDragActive && (
                <div className='bg-brand-subtle/90 border-brand pointer-events-none absolute inset-0 flex items-center justify-center rounded border-2 border-dashed'>
                    <span className='text-brand text-sm'>
                        Drop to upload to {currentPath}
                    </span>
                </div>
            )}
            {queue.length > 0 && (
                <div className='border-border absolute right-2 bottom-2 w-80 rounded border bg-white p-3 shadow-lg'>
                    <p className='text-caption-sm text-label mb-2'>
                        Uploading {queue.filter((q) => q.done).length}/
                        {queue.length}
                    </p>
                    <ul className='space-y-1'>
                        {queue.map((q) => (
                            <li key={q.name} className='text-caption-sm'>
                                <div className='flex justify-between'>
                                    <span className='truncate'>{q.name}</span>
                                    <span className='text-body'>
                                        {q.error
                                            ? 'error'
                                            : q.done
                                              ? 'done'
                                              : `${Math.round((q.loaded / Math.max(1, q.total)) * 100)}%`}
                                    </span>
                                </div>
                                {!q.done && !q.error && q.total > 0 && (
                                    <div className='bg-surface-muted h-1 overflow-hidden rounded'>
                                        <div
                                            className='bg-brand h-full'
                                            style={{
                                                width: `${(q.loaded / q.total) * 100}%`
                                            }}
                                        />
                                    </div>
                                )}
                                {q.error && (
                                    <p className='text-accent-ruby'>
                                        {q.error}
                                    </p>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            <button
                type='button'
                onClick={open}
                className='hidden'
                aria-hidden
            />
        </div>
    )
}
