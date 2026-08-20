import type { FC, ReactNode } from 'react'
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent as ReactMouseEvent
} from 'react'
import type { ContextMenuItem, ContextMenuOpenContext } from '@pierre/trees'
import { FileTree, useFileTree } from '@pierre/trees/react'
import { t } from '@manyfold/i18n'
import {
    Copy,
    Download,
    FolderPlus,
    Pencil,
    Trash2,
    Upload
} from 'lucide-react'
import { FILE_TREE_THEME } from './fileTreeTheme'
import {
    TreeContextMenuPanel,
    TreeMenuItem,
    TreeMenuSeparator
} from './treeMenu'
import {
    basename,
    joinPath,
    normalizeRelDir,
    treeDirPathForRelDir
} from './useAgentFileTree'

export interface FileTreeEntry {
    absPath: string
    isDir: boolean
    name: string
    relPath: string
}

export interface FileTreeActions {
    onActionError: (err: unknown) => void
    onDelete: (entry: FileTreeEntry) => void | Promise<void>
    onDownload: (entry: FileTreeEntry) => void | Promise<void>
    onNewFolder: (relDir: string) => void | Promise<void>
    onRename: (entry: FileTreeEntry) => void | Promise<void>
    onUpload: (relDir: string) => void
}

interface AgentFileTreeProps {
    actions: FileTreeActions
    expandedDirs: Set<string>
    loadedDirs: Set<string>
    loadingDirs: Set<string>
    dirErrors: Record<string, string>
    onExpandedChange: (relDir: string, expanded: boolean) => void
    onLoadDirectory: (relDir: string) => void
    onSelect: (relPath: string) => void
    paths: string[]
    rootPath: string
    writable: boolean
}

const stableId = (value: string): string =>
    value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'root'

const entryOf = (item: ContextMenuItem, rootPath: string): FileTreeEntry => {
    const relPath = normalizeRelDir(item.path)
    return {
        absPath: joinPath(rootPath, relPath),
        isDir: item.kind === 'directory',
        name: basename(relPath),
        relPath
    }
}

const AgentFileTreeMenu: FC<{
    actions: FileTreeActions
    item: ContextMenuItem
    menuContext: ContextMenuOpenContext
    rootPath: string
    writable: boolean
}> = ({ actions, item, menuContext, rootPath, writable }): ReactNode => {
    const entry = entryOf(item, rootPath)
    const run = (action: () => void | Promise<void>): void => {
        menuContext.close()
        void Promise.resolve(action()).catch(actions.onActionError)
    }
    const copy = (text: string) => (): Promise<void> =>
        navigator.clipboard.writeText(text)

    return (
        <TreeContextMenuPanel
            anchorRect={menuContext.anchorRect}
            title={entry.name}
        >
            <TreeMenuItem
                icon={<Copy />}
                label={t('admin.agents.detail.files.copyPath')}
                onClick={() => run(copy(entry.absPath))}
            />
            <TreeMenuItem
                icon={<Copy />}
                label={t('admin.agents.detail.files.copyRelativePath')}
                onClick={() => run(copy(entry.relPath))}
            />
            <TreeMenuItem
                icon={<Copy />}
                label={t('admin.agents.detail.files.copyFilename')}
                onClick={() => run(copy(entry.name))}
            />
            {!entry.isDir && (
                <>
                    <TreeMenuSeparator />
                    <TreeMenuItem
                        icon={<Download />}
                        label={t('admin.agents.detail.files.download')}
                        onClick={() => run(() => actions.onDownload(entry))}
                    />
                </>
            )}
            {entry.isDir && (
                <>
                    <TreeMenuSeparator />
                    <TreeMenuItem
                        icon={<FolderPlus />}
                        label={t('admin.agents.detail.files.newFolderHere')}
                        disabled={!writable}
                        onClick={() =>
                            run(() => actions.onNewFolder(entry.relPath))
                        }
                    />
                    <TreeMenuItem
                        icon={<Upload />}
                        label={t('admin.agents.detail.files.uploadHere')}
                        disabled={!writable}
                        onClick={() =>
                            run(() => actions.onUpload(entry.relPath))
                        }
                    />
                </>
            )}
            <TreeMenuSeparator />
            <TreeMenuItem
                icon={<Pencil />}
                label={t('admin.agents.detail.files.rename')}
                disabled={!writable}
                onClick={() => run(() => actions.onRename(entry))}
            />
            <TreeMenuItem
                tone='danger'
                icon={<Trash2 />}
                label={t('admin.agents.detail.files.delete')}
                disabled={!writable}
                onClick={() => run(() => actions.onDelete(entry))}
            />
        </TreeContextMenuPanel>
    )
}

export const AgentFileTree: FC<AgentFileTreeProps> = ({
    actions,
    expandedDirs,
    loadedDirs,
    loadingDirs,
    dirErrors,
    onExpandedChange,
    onLoadDirectory,
    onSelect,
    paths,
    rootPath,
    writable
}): ReactNode => {
    const onSelectRef = useRef(onSelect)
    const onLoadDirectoryRef = useRef(onLoadDirectory)
    const onExpandedChangeRef = useRef(onExpandedChange)
    const loadedDirsRef = useRef(loadedDirs)
    const loadingDirsRef = useRef(loadingDirs)
    const dirErrorsRef = useRef(dirErrors)

    const { model } = useFileTree({
        composition: {
            contextMenu: {
                buttonVisibility: 'when-needed',
                triggerMode: 'both'
            }
        },
        flattenEmptyDirectories: true,
        icons: { colored: true, set: 'complete' },
        initialExpansion: 'closed',
        itemHeight: 28,
        onSelectionChange: (selectedPaths) => {
            const path = selectedPaths.at(-1)
            if (path) onSelectRef.current(path)
        },
        paths: [],
        search: true
    })

    const directoryPaths = useMemo(
        () => new Set(paths.filter((path) => path.endsWith('/'))),
        [paths]
    )
    const initialExpandedPaths = useMemo(
        () =>
            Array.from(expandedDirs)
                .map(treeDirPathForRelDir)
                .filter((path) => path && directoryPaths.has(path)),
        [directoryPaths, expandedDirs]
    )

    useEffect(() => {
        onSelectRef.current = onSelect
    }, [onSelect])

    useEffect(() => {
        onLoadDirectoryRef.current = onLoadDirectory
    }, [onLoadDirectory])

    useEffect(() => {
        onExpandedChangeRef.current = onExpandedChange
    }, [onExpandedChange])

    useEffect(() => {
        loadedDirsRef.current = loadedDirs
    }, [loadedDirs])

    useEffect(() => {
        loadingDirsRef.current = loadingDirs
    }, [loadingDirs])

    useEffect(() => {
        dirErrorsRef.current = dirErrors
    }, [dirErrors])

    useEffect(() => {
        model.resetPaths(paths, { initialExpandedPaths })
    }, [initialExpandedPaths, model, paths, rootPath])

    const syncDirectoryExpansion = useCallback(
        (path: string | null | undefined): void => {
            if (!path) return
            const item = model.getItem(path)
            if (!item?.isDirectory()) return
            if (!('isExpanded' in item)) return
            const relDir = normalizeRelDir(item.getPath())
            const expanded = item.isExpanded()
            onExpandedChangeRef.current(relDir, expanded)
            if (
                expanded &&
                !loadedDirsRef.current.has(relDir) &&
                !loadingDirsRef.current.has(relDir) &&
                !dirErrorsRef.current[relDir]
            )
                onLoadDirectoryRef.current(relDir)
        },
        [model]
    )

    // @pierre/trees applies the expansion after the event it was triggered by,
    // so reading isExpanded() has to wait a tick.
    const scheduleDirectorySync = useCallback(
        (path: string | null | undefined): void => {
            window.setTimeout(() => syncDirectoryExpansion(path), 0)
        },
        [syncDirectoryExpansion]
    )

    const handleTreeClick = useCallback(
        (event: ReactMouseEvent<HTMLElement>): void => {
            const row = event.nativeEvent
                .composedPath()
                .find(
                    (target): target is HTMLElement =>
                        target instanceof HTMLElement &&
                        target.dataset.type === 'item'
                )
            const path = row?.dataset.itemPath
            if (!path) return
            if (row.dataset.itemType === 'file') {
                onSelectRef.current(path)
                return
            }
            scheduleDirectorySync(path)
        },
        [scheduleDirectorySync]
    )

    const handleTreeKeyDown = useCallback(
        (event: ReactKeyboardEvent<HTMLElement>): void => {
            if (
                event.key !== 'ArrowLeft' &&
                event.key !== 'ArrowRight' &&
                event.key !== 'Enter' &&
                event.key !== ' '
            )
                return
            scheduleDirectorySync(model.getFocusedPath())
        },
        [model, scheduleDirectorySync]
    )

    return (
        <FileTree
            id={`admin-agent-files-${stableId(rootPath)}`}
            model={model}
            onClick={handleTreeClick}
            onKeyDownCapture={handleTreeKeyDown}
            renderContextMenu={(item, menuContext) => (
                <AgentFileTreeMenu
                    actions={actions}
                    item={item}
                    menuContext={menuContext}
                    rootPath={rootPath}
                    writable={writable}
                />
            )}
            style={FILE_TREE_THEME}
        />
    )
}
