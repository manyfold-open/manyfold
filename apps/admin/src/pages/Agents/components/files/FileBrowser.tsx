import type {
    FileRootSdk,
    FsStatResponse
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FilesClient } from '@manyfold/sdk'
import { t } from '@manyfold/i18n'
import { Button } from '@/ui'
import { UploadZone } from './UploadZone'
import { FileEditor } from './FileEditor'
import { AgentFileTree } from './AgentFileTree'
import type { FileTreeActions, FileTreeEntry } from './AgentFileTree'
import { downloadEntry } from './downloadEntry'
import {
    basename,
    directoryAbsPath,
    joinPath,
    normalizeAbsPath,
    normalizeRelDir,
    relDirOf,
    useAgentFileTree
} from './useAgentFileTree'

interface FileBrowserProps {
    filesApi: FilesClient
    agentId: string
    roots: FileRootSdk[]
}

interface Selection {
    relPath: string
    absPath: string
    stat?: FsStatResponse
}

export const FileBrowser: FC<FileBrowserProps> = ({
    filesApi,
    agentId,
    roots
}): ReactNode => {
    const [currentRootId, setCurrentRootId] = useState<string>(
        () => roots[0]?.id ?? ''
    )
    const currentRoot = useMemo(
        () => roots.find((r) => r.id === currentRootId) ?? roots[0],
        [roots, currentRootId]
    )
    const rootId = currentRoot?.id ?? ''
    const rootPath = useMemo(
        () => normalizeAbsPath(currentRoot?.path ?? '/'),
        [currentRoot?.path]
    )
    const writable = currentRoot?.writable ?? false

    const [selection, setSelection] = useState<Selection | null>(null)
    const [selectedDir, setSelectedDir] = useState('')
    const [busyError, setBusyError] = useState<string | null>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)
    const uploadTargetRef = useRef('')

    const tree = useAgentFileTree(filesApi, agentId, rootId, rootPath, true)
    const { refreshDir } = tree

    useEffect(() => {
        setSelection(null)
        setSelectedDir('')
        setBusyError(null)
    }, [agentId, rootId])

    const reportError = useCallback((err: unknown): void => {
        setBusyError(err instanceof Error ? err.message : String(err))
    }, [])

    const onSelect = useCallback(
        (treePath: string): void => {
            if (treePath.endsWith('/')) {
                setSelectedDir(normalizeRelDir(treePath))
                return
            }
            const relPath = normalizeRelDir(treePath)
            const absPath = joinPath(rootPath, relPath)
            setSelectedDir(relDirOf(relPath))
            setSelection({ relPath, absPath })
            filesApi
                .stat(agentId, absPath, { rootId })
                .then((stat) => {
                    setSelection((prev) =>
                        prev?.relPath === relPath ? { ...prev, stat } : prev
                    )
                })
                .catch(reportError)
        },
        [agentId, filesApi, reportError, rootId, rootPath]
    )

    const newFolderIn = useCallback(
        async (relDir: string): Promise<void> => {
            const name = window.prompt(
                t('admin.agents.detail.files.newFolderPrompt')
            )
            if (!name) return
            if (name.includes('/')) {
                setBusyError(t('admin.agents.detail.files.nameSlash'))
                return
            }
            await filesApi.mkdir(
                agentId,
                joinPath(directoryAbsPath(rootPath, relDir), name),
                { rootId }
            )
            await refreshDir(relDir)
        },
        [agentId, filesApi, refreshDir, rootId, rootPath]
    )

    const renameEntry = useCallback(
        async (entry: FileTreeEntry): Promise<void> => {
            const next = window.prompt(
                t('admin.agents.detail.files.renamePrompt'),
                entry.name
            )
            if (!next || next === entry.name) return
            if (next.includes('/')) {
                setBusyError(t('admin.agents.detail.files.nameSlash'))
                return
            }
            const parent = relDirOf(entry.relPath)
            await filesApi.mv(
                agentId,
                entry.absPath,
                joinPath(directoryAbsPath(rootPath, parent), next),
                { rootId }
            )
            if (selection?.relPath === entry.relPath) setSelection(null)
            await refreshDir(parent)
        },
        [agentId, filesApi, refreshDir, rootId, rootPath, selection?.relPath]
    )

    const deleteEntry = useCallback(
        async (entry: FileTreeEntry): Promise<void> => {
            if (
                !window.confirm(
                    t('admin.agents.detail.files.deleteConfirm', {
                        name: entry.name
                    })
                )
            )
                return
            await filesApi.rm(agentId, entry.absPath, {
                recursive: entry.isDir,
                rootId
            })
            const gone =
                selection?.relPath === entry.relPath ||
                selection?.relPath.startsWith(`${entry.relPath}/`)
            if (gone) setSelection(null)
            await refreshDir(relDirOf(entry.relPath))
        },
        [agentId, filesApi, refreshDir, rootId, selection?.relPath]
    )

    const requestUpload = useCallback((relDir: string): void => {
        uploadTargetRef.current = relDir
        fileInputRef.current?.click()
    }, [])

    const onInputFiles = useCallback(
        async (files: FileList | null): Promise<void> => {
            const relDir = uploadTargetRef.current
            const input = fileInputRef.current
            const picked = Array.from(files ?? [])
            if (input) input.value = ''
            if (picked.length === 0) return
            const absDir = directoryAbsPath(rootPath, relDir)
            try {
                for (const file of picked)
                    await filesApi.write(
                        agentId,
                        joinPath(absDir, file.name),
                        file,
                        { rootId }
                    )
            } catch (err) {
                reportError(err)
            }
            await refreshDir(relDir)
        },
        [agentId, filesApi, refreshDir, reportError, rootId, rootPath]
    )

    const actions = useMemo<FileTreeActions>(
        () => ({
            onActionError: reportError,
            onDelete: deleteEntry,
            onDownload: (entry) =>
                downloadEntry(filesApi, agentId, entry.absPath, rootId),
            onNewFolder: newFolderIn,
            onRename: renameEntry,
            onUpload: requestUpload
        }),
        [
            agentId,
            deleteEntry,
            filesApi,
            newFolderIn,
            renameEntry,
            reportError,
            requestUpload,
            rootId
        ]
    )

    const dirError = Object.entries(tree.dirErrors)[0]
    const loadingDir = tree.loadingDirs.values().next().value ?? null

    return (
        <div className='border-border flex h-[72vh] flex-col overflow-hidden rounded border'>
            {roots.length > 1 && (
                <div className='border-border bg-surface-muted flex items-center gap-1 border-b px-3 py-1.5'>
                    {roots.map((r) => {
                        const active = r.id === rootId
                        return (
                            <button
                                key={r.id}
                                type='button'
                                className={`text-caption-sm rounded px-2 py-1 ${
                                    active
                                        ? 'bg-brand text-white'
                                        : 'text-body hover:bg-brand-subtle'
                                }`}
                                onClick={() => setCurrentRootId(r.id)}
                            >
                                {r.label}
                                {!r.writable && (
                                    <span className='text-body/50 ml-1'>
                                        (
                                        {t(
                                            'admin.agents.detail.files.readOnly'
                                        )}
                                        )
                                    </span>
                                )}
                            </button>
                        )
                    })}
                </div>
            )}
            <div className='border-border bg-surface-muted flex items-center gap-2 border-b px-3 py-2'>
                <span className='text-caption-sm text-body min-w-0 flex-1 truncate font-mono'>
                    {directoryAbsPath(rootPath, selectedDir)}
                </span>
                <Button
                    size='sm'
                    variant='ghost'
                    onClick={() => void refreshDir(selectedDir)}
                >
                    {t('admin.agents.detail.files.refresh')}
                </Button>
                <Button
                    size='sm'
                    variant='ghost'
                    onClick={() => {
                        void newFolderIn(selectedDir).catch(reportError)
                    }}
                    disabled={!writable}
                >
                    {t('admin.agents.detail.files.newFolder')}
                </Button>
                <Button
                    size='sm'
                    variant='primary'
                    onClick={() => requestUpload(selectedDir)}
                    disabled={!writable}
                >
                    {t('admin.agents.detail.files.upload')}
                </Button>
                <input
                    ref={fileInputRef}
                    type='file'
                    multiple
                    className='hidden'
                    onChange={(e) => void onInputFiles(e.target.files)}
                />
            </div>
            {busyError && (
                <div className='bg-accent-ruby/10 text-accent-ruby border-accent-ruby/20 text-caption-sm border-b px-3 py-2'>
                    {busyError}{' '}
                    <button
                        type='button'
                        className='ml-2 underline'
                        onClick={() => setBusyError(null)}
                    >
                        {t('admin.agents.detail.files.dismiss')}
                    </button>
                </div>
            )}
            <div className='grid min-h-0 flex-1 grid-cols-[minmax(280px,1fr)_2fr]'>
                <UploadZone
                    filesApi={filesApi}
                    agentId={agentId}
                    currentPath={directoryAbsPath(rootPath, selectedDir)}
                    rootId={rootId}
                    disabled={!writable}
                    onComplete={() => void refreshDir(selectedDir)}
                >
                    <div className='border-border flex h-full min-h-0 flex-col border-r'>
                        <div className='min-h-0 flex-1'>
                            {tree.loading && (
                                <p className='text-caption text-body p-3'>
                                    {t('admin.agents.detail.files.loading')}
                                </p>
                            )}
                            {tree.error && (
                                <p className='text-caption-sm text-accent-ruby p-3'>
                                    {tree.error}
                                </p>
                            )}
                            {!tree.loading &&
                                !tree.error &&
                                tree.paths.length === 0 && (
                                    <p className='text-caption text-body/60 p-3'>
                                        {t('admin.agents.detail.files.empty')}
                                    </p>
                                )}
                            {!tree.loading &&
                                !tree.error &&
                                tree.paths.length > 0 && (
                                    <AgentFileTree
                                        actions={actions}
                                        dirErrors={tree.dirErrors}
                                        expandedDirs={tree.expandedDirs}
                                        loadedDirs={tree.loadedDirs}
                                        loadingDirs={tree.loadingDirs}
                                        onExpandedChange={tree.setExpanded}
                                        onLoadDirectory={tree.loadDirectory}
                                        onSelect={onSelect}
                                        paths={tree.paths}
                                        rootPath={rootPath}
                                        writable={writable}
                                    />
                                )}
                        </div>
                        {loadingDir !== null && (
                            <div className='border-border text-caption-sm text-body truncate border-t px-3 py-1.5'>
                                {t('admin.agents.detail.files.loadingDir', {
                                    name: loadingDir
                                        ? basename(loadingDir)
                                        : rootPath
                                })}
                            </div>
                        )}
                        {loadingDir === null && dirError && (
                            <div className='border-border text-caption-sm text-accent-ruby flex items-center gap-2 border-t px-3 py-1.5'>
                                <span className='min-w-0 flex-1 truncate'>
                                    {t('admin.agents.detail.files.loadFailed', {
                                        name: dirError[0]
                                            ? basename(dirError[0])
                                            : rootPath
                                    })}
                                    : {dirError[1]}
                                </span>
                                <button
                                    type='button'
                                    className='text-brand shrink-0 underline'
                                    onClick={() => void refreshDir(dirError[0])}
                                >
                                    {t('admin.agents.detail.files.retry')}
                                </button>
                            </div>
                        )}
                    </div>
                </UploadZone>
                <div className='h-full min-h-0 overflow-auto'>
                    {selection?.stat ? (
                        <FileEditor
                            filesApi={filesApi}
                            agentId={agentId}
                            path={selection.absPath}
                            size={selection.stat.size}
                            contentType={selection.stat.contentType}
                            rootId={rootId}
                            writable={writable}
                            onSaved={() =>
                                void refreshDir(relDirOf(selection.relPath))
                            }
                        />
                    ) : selection ? (
                        <p className='text-caption text-body p-2'>
                            {t('admin.agents.detail.files.loading')}
                        </p>
                    ) : (
                        <p className='text-caption text-body/60 p-2'>
                            {t('admin.agents.detail.files.selectFile')}
                        </p>
                    )}
                </div>
            </div>
        </div>
    )
}
