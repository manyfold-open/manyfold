import type {
    FileRootSdk,
    FsEntrySdk,
    FsStatResponse
} from '@manyfold/shared'
import type { CSSProperties, FC, ReactNode } from 'react'
import {
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    useState
} from 'react'
import { createPortal } from 'react-dom'
import { SidePaneHeaderSlotContext } from '@/components/chat/SidePane'
import type { ContextMenuItem, ContextMenuOpenContext } from '@pierre/trees'
import { FileTree, useFileTree } from '@pierre/trees/react'
import type { FilesClient, SdkAgent } from '@manyfold/sdk'
import {
    CheckIcon,
    ChevronDownIcon,
    ChevronRightIcon,
    CloseIcon,
    CodeIcon,
    CopyIcon,
    DownloadIcon,
    FileIcon,
    PaperclipIcon,
    SearchIcon,
    SidebarToggleIcon,
    TerminalIcon,
    UploadIcon
} from '@/components/icons'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { Ghost, SheenText } from '@/components/Loading'
import { useI18n } from '@/lib/i18n'
import type { TFn } from '@/lib/i18n'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { FILE_TREE_THEME } from '@/components/files/fileTreeTheme'
import {
    copyTextToClipboard,
    TreeContextMenuPanel,
    TreeMenuItem
} from '@/components/files/treeMenu'
import { downloadFile } from '@/components/chat/utils/downloadFile'
import MarkdownText from '@/components/chat/MarkdownText'
import CodePreview from '@/components/chat/preview/CodePreview'
import CsvPreview from '@/components/chat/preview/CsvPreview'
import DocxPreview from '@/components/chat/preview/DocxPreview'
import HtmlPreview from '@/components/chat/preview/HtmlPreview'
import PreviewErrorBoundary from '@/components/chat/preview/PreviewErrorBoundary'
import SqlitePreview from '@/components/chat/preview/SqlitePreview'
import XlsxPreview from '@/components/chat/preview/XlsxPreview'
import {
    binaryPreviewKind,
    binaryPreviewLimit,
    codeLanguageFor,
    isHtmlExt,
    isLegacyExcelExt
} from '@/components/chat/preview/previewKinds'

interface WorkspaceFilesProps {
    agent: SdkAgent
    onAttachContext?: (contextRef: WorkspaceFileContextRef) => void
    onOpenTerminal?: (request: WorkspaceFileTerminalRequest) => void
    onPreviewAvailableChange?: (available: boolean) => void
    onPreviewRequestHandled?: (requestId: number) => void
    onPreviewVisibleChange?: (visible: boolean) => void
    onToggleTree?: () => void
    previewRequest?: WorkspaceFilePreviewRequest | null
    previewVisible?: boolean
    refreshKey?: number
    visible?: boolean
}

export interface WorkspaceFilePreviewRequest {
    id: number
    relPath: string
    rootId: string
}

export interface WorkspaceFileContextRef {
    path: string
    rootId: string
    name: string
    entryType: 'file' | 'dir'
    contentType?: string
    size?: number
}

export interface WorkspaceFileTerminalRequest {
    cwdPath: string
    rootId: string
    label: string
}

interface PreviewState {
    tabs: string[]
    activePath: string | null
}

interface UploadTarget {
    absPath: string
    relDir: string
    rootId: string
}

type PreviewContent =
    | { kind: 'empty' }
    | { kind: 'text'; text: string }
    | { kind: 'markdown'; text: string }
    | { kind: 'image'; url: string; contentType: string }
    | { kind: 'unsupported'; reason: string }
    | { kind: 'code'; text: string; language: string }
    | { kind: 'csv'; text: string }
    | { kind: 'html'; text: string }
    | { kind: 'docx'; data: ArrayBuffer }
    | { kind: 'xlsx'; data: ArrayBuffer }
    | { kind: 'sqlite'; data: ArrayBuffer; walWarning: boolean }

const RAW_TOGGLE_KINDS = new Set<PreviewContent['kind']>([
    'markdown',
    'code',
    'csv',
    'html'
])

const DEFAULT_WORKSPACE_PATH = '/workspace'
const MAX_TEXT_PREVIEW_BYTES = 1_000_000
const MAX_IMAGE_PREVIEW_BYTES = 5_000_000
const DEFAULT_FILES_PANEL_WIDTH = 352
const MIN_FILES_PANEL_WIDTH = 260
const MAX_FILES_PANEL_WIDTH = 560
const DEFAULT_STACK_FILES_RATIO = 0.52
const MIN_STACK_FILES_RATIO = 0.28
const MAX_STACK_FILES_RATIO = 0.72
const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown'])
const TEXT_EXTENSIONS = new Set([
    'bash',
    'c',
    'conf',
    'cpp',
    'css',
    'csv',
    'dockerfile',
    'env',
    'go',
    'h',
    'htm',
    'html',
    'js',
    'json',
    'jsonl',
    'jsx',
    'log',
    'mjs',
    'ndjson',
    'py',
    'rb',
    'rs',
    'sh',
    'sql',
    'toml',
    'ts',
    'tsx',
    'txt',
    'xml',
    'yaml',
    'yml',
    'zsh'
])
const WorkspaceFiles: FC<WorkspaceFilesProps> = ({
    agent,
    onAttachContext,
    onOpenTerminal,
    onPreviewAvailableChange,
    onPreviewRequestHandled,
    onPreviewVisibleChange,
    onToggleTree,
    previewRequest = null,
    previewVisible = true,
    refreshKey = 0,
    visible = true
}): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const available = agent.status === 'running'
    const [paths, setPaths] = useState<string[]>([])
    const [previewState, setPreviewState] = useState<PreviewState>({
        tabs: [],
        activePath: null
    })
    const filesPanelRef = useRef<HTMLElement | null>(null)
    const [filesPanelWidth, setFilesPanelWidth] = useState(
        DEFAULT_FILES_PANEL_WIDTH
    )
    const [stackFilesRatio, setStackFilesRatio] = useState(
        DEFAULT_STACK_FILES_RATIO
    )
    const [loading, setLoading] = useState(available)
    const [error, setError] = useState<string | null>(null)
    const [loadedDirs, setLoadedDirs] = useState<Set<string>>(() => new Set())
    const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set())
    const [dirErrors, setDirErrors] = useState<Record<string, string>>({})
    const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
        () => new Set()
    )
    const loadedDirsRef = useRef<Set<string>>(new Set())
    const loadingDirsRef = useRef<Set<string>>(new Set())
    const loadGenerationRef = useRef(0)
    const directoryLoadControllersRef = useRef<Set<AbortController>>(new Set())
    const handledPreviewRequestRef = useRef<number | null>(null)
    const uploadInputRef = useRef<HTMLInputElement | null>(null)
    const uploadTargetRef = useRef<UploadTarget | null>(null)
    const [localRefreshVersion, setLocalRefreshVersion] = useState(0)
    const [actionError, setActionError] = useState<string | null>(null)
    const [searchExpanded, setSearchExpanded] = useState(false)
    const [searchTerm, setSearchTerm] = useState('')
    const collapseSearch = useCallback((): void => {
        setSearchTerm('')
        setSearchExpanded(false)
    }, [])
    const reportActionError = useCallback((err: unknown): void => {
        const message = err instanceof Error ? err.message : String(err)
        setActionError(message)
        window.setTimeout(() => {
            setActionError((current) => (current === message ? null : current))
        }, 5000)
    }, [])
    const requestUpload = useCallback((target: UploadTarget): void => {
        uploadTargetRef.current = target
        uploadInputRef.current?.click()
    }, [])
    const handleUploadInputChange = useCallback(async (): Promise<void> => {
        const input = uploadInputRef.current
        const files = Array.from(input?.files ?? [])
        const target = uploadTargetRef.current
        if (input) input.value = ''
        uploadTargetRef.current = null
        if (!target || files.length === 0) return
        try {
            for (const file of files) {
                await client.files.write(
                    agent.id,
                    joinPath(target.absPath, file.name),
                    file,
                    { rootId: target.rootId }
                )
            }
            const refreshedPaths = await loadDirectoryEntries(
                client.files,
                agent.id,
                target.absPath,
                target.rootId,
                target.relDir
            )
            setPaths((prev) => mergeKnownPaths(prev, refreshedPaths))
            const nextLoaded = new Set(loadedDirsRef.current)
            nextLoaded.add(target.relDir)
            loadedDirsRef.current = nextLoaded
            setLoadedDirs(nextLoaded)
            setDirErrors((prev) => omitRecordKey(prev, target.relDir))
            setActionError(null)
        } catch (err) {
            reportActionError(err)
        }
    }, [agent.id, client.files, reportActionError])
    const filteredPaths = useMemo(() => {
        const q = searchTerm.trim().toLowerCase()
        if (!q) return paths
        const matched = new Set<string>()
        for (const p of paths) {
            if (!p.toLowerCase().includes(q)) continue
            matched.add(p)
            const segs = p.replace(/\/$/, '').split('/').filter(Boolean)
            let acc = ''
            for (let i = 0; i < segs.length - 1; i++) {
                acc = acc ? `${acc}/${segs[i]}` : segs[i]
                matched.add(`${acc}/`)
            }
        }
        return paths.filter((p) => matched.has(p))
    }, [paths, searchTerm])
    const isSearching = searchTerm.trim().length > 0
    const fallbackRoot = useMemo<FileRootSdk>(
        () => ({
            id: 'workspace',
            label: t('web.workspaceFiles.workspaceLabel'),
            path: normalizeAbsPath(
                agent.workspacePath || agent.mountPath || DEFAULT_WORKSPACE_PATH
            ),
            writable: true
        }),
        [agent.mountPath, agent.workspacePath, t]
    )
    const [roots, setRoots] = useState<FileRootSdk[]>([fallbackRoot])
    const [rootsReady, setRootsReady] = useState(!available)
    const [selectedRootId, setSelectedRootId] = useState<string>(
        () => readStoredRoot(agent.id) ?? fallbackRoot.id
    )
    const selectedRoot = useMemo(
        () =>
            roots.find((r) => r.id === selectedRootId) ??
            roots[0] ??
            fallbackRoot,
        [fallbackRoot, roots, selectedRootId]
    )
    const rootId = selectedRoot.id
    const rootPath = useMemo(
        () => normalizeAbsPath(selectedRoot.path),
        [selectedRoot.path]
    )
    const rootLabel = useMemo(() => selectedRoot.label, [selectedRoot.label])
    const activePreviewPath = previewState.activePath
    const previewAvailable = Boolean(activePreviewPath && available)
    const previewOpen = previewAvailable && previewVisible
    const filesActive = visible || previewOpen
    const handlePreviewPath = useCallback(
        (path: string): void => {
            if (path.endsWith('/')) return
            setPreviewState((prev) => ({
                tabs: prev.tabs.includes(path)
                    ? prev.tabs
                    : [...prev.tabs, path],
                activePath: path
            }))
            onPreviewVisibleChange?.(true)
        },
        [onPreviewVisibleChange]
    )
    const handleRootSelect = useCallback((nextRootId: string): void => {
        setSelectedRootId(nextRootId)
        setPreviewState({ tabs: [], activePath: null })
    }, [])
    const selectPreviewTab = useCallback((path: string): void => {
        setPreviewState((prev) =>
            prev.tabs.includes(path) ? { ...prev, activePath: path } : prev
        )
    }, [])
    const closePreviewTab = useCallback((path: string): void => {
        setPreviewState((prev) => {
            const index = prev.tabs.indexOf(path)
            if (index === -1) return prev
            const tabs = prev.tabs.filter((tab) => tab !== path)
            const activePath =
                prev.activePath === path
                    ? (tabs[Math.min(index, tabs.length - 1)] ?? null)
                    : prev.activePath
            return { tabs, activePath }
        })
    }, [])

    useEffect(() => {
        onPreviewAvailableChange?.(previewAvailable)
    }, [onPreviewAvailableChange, previewAvailable])

    useEffect(() => {
        if (!available) {
            setRoots([fallbackRoot])
            setRootsReady(false)
            return
        }
        if (!filesActive) return
        let cancelled = false
        const controller = new AbortController()
        setRootsReady(false)
        client.files
            .roots(agent.id, { signal: controller.signal })
            .then((result) => {
                if (cancelled) return
                const fetched =
                    result.roots.length > 0 ? result.roots : [fallbackRoot]
                setRoots(fetched)
                setSelectedRootId((prev) => {
                    if (fetched.some((r) => r.id === prev)) return prev
                    const stored = readStoredRoot(agent.id)
                    if (stored && fetched.some((r) => r.id === stored))
                        return stored
                    return fetched[0].id
                })
                setRootsReady(true)
            })
            .catch(() => {
                if (cancelled || controller.signal.aborted) return
                setRoots([fallbackRoot])
                setSelectedRootId(fallbackRoot.id)
                setRootsReady(true)
            })
        return (): void => {
            cancelled = true
            controller.abort()
        }
    }, [agent.id, available, client.files, fallbackRoot, filesActive])

    useEffect(() => {
        writeStoredRoot(agent.id, selectedRootId)
    }, [agent.id, selectedRootId])

    useEffect(() => {
        setPreviewState({ tabs: [], activePath: null })
        handledPreviewRequestRef.current = null
    }, [agent.id])

    useEffect(() => {
        if (!previewRequest) return
        if (handledPreviewRequestRef.current === previewRequest.id) return
        if (!available) return
        if (!rootsReady && previewRequest.rootId !== fallbackRoot.id) return
        if (
            rootsReady &&
            !roots.some((root) => root.id === previewRequest.rootId)
        )
            return

        handledPreviewRequestRef.current = previewRequest.id
        setSelectedRootId(previewRequest.rootId)
        handlePreviewPath(previewRequest.relPath)
        onPreviewRequestHandled?.(previewRequest.id)
    }, [
        available,
        fallbackRoot.id,
        handlePreviewPath,
        onPreviewRequestHandled,
        previewRequest,
        roots,
        rootsReady
    ])

    const resetDirectoryTracking = useCallback((): void => {
        for (const controller of directoryLoadControllersRef.current)
            controller.abort()
        directoryLoadControllersRef.current.clear()
        const nextLoaded = new Set<string>()
        const nextLoading = new Set<string>()
        loadedDirsRef.current = nextLoaded
        loadingDirsRef.current = nextLoading
        setLoadedDirs(nextLoaded)
        setLoadingDirs(nextLoading)
        setDirErrors({})
        setExpandedDirs(new Set())
    }, [])

    useEffect(() => {
        return (): void => {
            loadGenerationRef.current += 1
            for (const controller of directoryLoadControllersRef.current)
                controller.abort()
            directoryLoadControllersRef.current.clear()
        }
    }, [])

    useEffect(() => {
        if (!filesActive) {
            loadGenerationRef.current += 1
            resetDirectoryTracking()
            setLoading(false)
            return
        }

        const generation = loadGenerationRef.current + 1
        loadGenerationRef.current = generation
        resetDirectoryTracking()

        if (!available) {
            setLoading(false)
            setPaths([])
            setError(null)
            return
        }
        if (!rootsReady) {
            setLoading(true)
            setPaths([])
            setError(null)
            return
        }
        let cancelled = false
        const controller = new AbortController()
        setLoading(true)
        setError(null)
        loadDirectoryEntries(
            client.files,
            agent.id,
            rootPath,
            rootId,
            '',
            controller.signal
        )
            .then((rootPaths) => {
                if (cancelled || loadGenerationRef.current !== generation)
                    return
                const nextLoaded = new Set<string>([''])
                loadedDirsRef.current = nextLoaded
                setLoadedDirs(nextLoaded)
                setPaths(rootPaths)
            })
            .catch((err) => {
                if (
                    cancelled ||
                    controller.signal.aborted ||
                    loadGenerationRef.current !== generation
                )
                    return
                setPaths([])
                setError(apiErrorMessage(err))
            })
            .finally(() => {
                if (
                    !cancelled &&
                    !controller.signal.aborted &&
                    loadGenerationRef.current === generation
                )
                    setLoading(false)
            })
        return (): void => {
            cancelled = true
            controller.abort()
        }
    }, [
        agent.id,
        available,
        client.files,
        localRefreshVersion,
        refreshKey,
        rootsReady,
        rootId,
        rootPath,
        resetDirectoryTracking,
        filesActive
    ])

    const handleExpandedDirectoryChange = useCallback(
        (relDirInput: string, expanded: boolean): void => {
            const relDir = normalizeRelDir(relDirInput)
            setExpandedDirs((prev) => {
                const alreadyExpanded = prev.has(relDir)
                if (alreadyExpanded === expanded) return prev
                const next = new Set(prev)
                if (expanded) next.add(relDir)
                else next.delete(relDir)
                return next
            })
        },
        []
    )

    const handleLoadDirectory = useCallback(
        async (relDirInput: string): Promise<void> => {
            const relDir = normalizeRelDir(relDirInput)
            if (!available || !rootsReady) return
            if (
                loadedDirsRef.current.has(relDir) ||
                loadingDirsRef.current.has(relDir)
            )
                return

            const generation = loadGenerationRef.current
            const nextLoading = new Set(loadingDirsRef.current)
            nextLoading.add(relDir)
            loadingDirsRef.current = nextLoading
            setLoadingDirs(nextLoading)
            setDirErrors((prev) => omitRecordKey(prev, relDir))

            const controller = new AbortController()
            directoryLoadControllersRef.current.add(controller)
            try {
                const childPaths = await loadDirectoryEntries(
                    client.files,
                    agent.id,
                    directoryAbsPath(rootPath, relDir),
                    rootId,
                    relDir,
                    controller.signal
                )
                if (loadGenerationRef.current !== generation) return
                setPaths((prev) => mergeKnownPaths(prev, childPaths))
                const nextLoaded = new Set(loadedDirsRef.current)
                nextLoaded.add(relDir)
                loadedDirsRef.current = nextLoaded
                setLoadedDirs(nextLoaded)
            } catch (err) {
                if (
                    controller.signal.aborted ||
                    loadGenerationRef.current !== generation
                )
                    return
                setDirErrors((prev) => ({
                    ...prev,
                    [relDir]: (err as Error).message
                }))
            } finally {
                directoryLoadControllersRef.current.delete(controller)
                if (
                    !controller.signal.aborted &&
                    loadGenerationRef.current === generation
                ) {
                    const remainingLoading = new Set(loadingDirsRef.current)
                    remainingLoading.delete(relDir)
                    loadingDirsRef.current = remainingLoading
                    setLoadingDirs(remainingLoading)
                }
            }
        },
        [agent.id, available, client.files, rootId, rootPath, rootsReady]
    )

    const startPanelResize = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>): void => {
            if (event.button !== 0) return
            event.preventDefault()
            const startX = event.clientX
            const startFilesWidth = filesPanelWidth
            const previousCursor = document.body.style.cursor
            const previousUserSelect = document.body.style.userSelect
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'

            const onMove = (moveEvent: PointerEvent): void => {
                const dx = moveEvent.clientX - startX
                setFilesPanelWidth(
                    clamp(
                        startFilesWidth + dx,
                        MIN_FILES_PANEL_WIDTH,
                        MAX_FILES_PANEL_WIDTH
                    )
                )
            }

            const onUp = (): void => {
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
                document.body.style.cursor = previousCursor
                document.body.style.userSelect = previousUserSelect
            }

            window.addEventListener('pointermove', onMove)
            window.addEventListener('pointerup', onUp)
        },
        [filesPanelWidth]
    )

    const startStackResize = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>): void => {
            if (event.button !== 0 && event.pointerType !== 'touch') return
            event.preventDefault()
            event.stopPropagation()
            const handle = event.currentTarget

            const container = event.currentTarget.parentElement
            const containerHeight =
                container?.getBoundingClientRect().height ?? 0
            if (containerHeight <= 0) return
            handle.setPointerCapture(event.pointerId)

            const startY = event.clientY
            const startRatio = stackFilesRatio
            let nextRatio = startRatio
            const previousCursor = document.body.style.cursor
            const previousUserSelect = document.body.style.userSelect
            document.body.style.cursor = 'row-resize'
            document.body.style.userSelect = 'none'

            const onMove = (moveEvent: PointerEvent): void => {
                const dy = moveEvent.clientY - startY
                nextRatio = clamp(
                    startRatio + dy / containerHeight,
                    MIN_STACK_FILES_RATIO,
                    MAX_STACK_FILES_RATIO
                )
                filesPanelRef.current?.style.setProperty(
                    '--workspace-files-basis',
                    `${nextRatio * 100}%`
                )
            }

            const onUp = (): void => {
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
                window.removeEventListener('pointercancel', onUp)
                if (handle.hasPointerCapture(event.pointerId))
                    handle.releasePointerCapture(event.pointerId)
                setStackFilesRatio(nextRatio)
                document.body.style.cursor = previousCursor
                document.body.style.userSelect = previousUserSelect
            }

            window.addEventListener('pointermove', onMove)
            window.addEventListener('pointerup', onUp)
            window.addEventListener('pointercancel', onUp)
        },
        [stackFilesRatio]
    )

    if (!visible && !previewOpen) return null

    const loadingDir = firstSetValue(loadingDirs)
    const firstDirError = firstRecordEntry(dirErrors)

    const filesPanelClass = [
        'bg-main order-1 flex min-h-0 w-full flex-col lg:order-none',
        previewOpen
            ? 'basis-[var(--workspace-files-basis)] shrink lg:basis-auto lg:w-[var(--workspace-files-width)] lg:max-w-[55%] lg:flex-none lg:shrink-0'
            : 'flex-1'
    ].join(' ')

    return (
        <div className='flex min-h-0 w-full flex-1 flex-col lg:flex-row'>
            {previewOpen && activePreviewPath && (
                <>
                    <WorkspaceFilePreview
                        activeRelPath={activePreviewPath}
                        agentId={agent.id}
                        filesApi={client.files}
                        onCloseTab={closePreviewTab}
                        onSelectTab={selectPreviewTab}
                        treeVisible={visible}
                        onToggleTree={onToggleTree}
                        rootId={rootId}
                        rootLabel={rootLabel}
                        rootPath={rootPath}
                        tabs={previewState.tabs}
                    />
                    {visible && (
                        <>
                            <WorkspaceStackResizeHandle
                                label={t(
                                    'web.workspaceFiles.resizeFilesPreview'
                                )}
                                onPointerDown={startStackResize}
                            />
                            <WorkspaceResizeHandle
                                label={t(
                                    'web.workspaceFiles.resizePreviewFiles'
                                )}
                                onPointerDown={startPanelResize}
                            />
                        </>
                    )}
                </>
            )}
            {visible && (
                <aside
                    ref={filesPanelRef}
                    className={filesPanelClass}
                    style={
                        {
                            '--workspace-files-basis': `${stackFilesRatio * 100}%`,
                            '--workspace-files-width': `${filesPanelWidth}px`
                        } as CSSProperties
                    }
                >
                    <div className='border-divider/80 text-caption text-placeholder flex h-11 shrink-0 items-center gap-2 border-b px-4'>
                        <div className='min-w-0 flex-1'>
                            <WorkspaceRootPicker
                                roots={roots}
                                selectedRootId={rootId}
                                onSelect={handleRootSelect}
                            />
                        </div>
                        {searchExpanded ? (
                            <div className='flex shrink-0 items-center gap-1'>
                                <input
                                    autoFocus
                                    type='search'
                                    value={searchTerm}
                                    onChange={(e) =>
                                        setSearchTerm(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                        if (e.key === 'Escape') collapseSearch()
                                    }}
                                    placeholder={t(
                                        'web.workspaceFiles.filterPlaceholder'
                                    )}
                                    aria-label={t(
                                        'web.workspaceFiles.filterAria'
                                    )}
                                    className='border-divider/80 text-caption text-fg placeholder:text-placeholder focus:border-link h-7 w-44 rounded-md border bg-transparent px-2 outline-none transition-colors focus:ring-0'
                                />
                                <ShortcutTooltip
                                    label={t('web.workspaceFiles.closeSearch')}
                                    placement='bottom-end'
                                    className='shrink-0'
                                >
                                    <button
                                        type='button'
                                        aria-label={t(
                                            'web.workspaceFiles.closeSearch'
                                        )}
                                        onClick={collapseSearch}
                                        className='text-placeholder hover:bg-surface-hover rounded-pill inline-flex h-7 w-7 shrink-0 items-center justify-center transition-colors'
                                    >
                                        <CloseIcon className='h-3.5 w-3.5' />
                                    </button>
                                </ShortcutTooltip>
                            </div>
                        ) : (
                            <ShortcutTooltip
                                label={t('web.workspaceFiles.searchFiles')}
                                placement='bottom-end'
                                className='shrink-0'
                            >
                                <button
                                    type='button'
                                    aria-label={t(
                                        'web.workspaceFiles.searchFiles'
                                    )}
                                    onClick={() => setSearchExpanded(true)}
                                    className='text-placeholder hover:bg-surface-hover rounded-pill inline-flex h-7 w-7 shrink-0 items-center justify-center transition-colors'
                                >
                                    <SearchIcon className='h-3.5 w-3.5' />
                                </button>
                            </ShortcutTooltip>
                        )}
                    </div>
                    <div className='min-h-0 flex-1'>
                        {!available ? (
                            <WorkspaceFilesState>
                                {t('web.workspaceFiles.agentStatus', {
                                    status: agent.status
                                })}
                            </WorkspaceFilesState>
                        ) : loading ? (
                            <div aria-busy='true' className='px-3 py-2'>
                                {GHOST_FILE_ROWS.map((row) => (
                                    <div
                                        key={row}
                                        className='flex items-center gap-2 px-1 py-[7px]'
                                    >
                                        <Ghost
                                            variant='circle'
                                            className='h-4 w-4 shrink-0'
                                        />
                                        <Ghost
                                            variant='cap'
                                            className={ghostFileWidth[row % 5]}
                                        />
                                    </div>
                                ))}
                            </div>
                        ) : error ? (
                            <div className='p-4'>
                                <div className='workbench-alert-error break-words'>
                                    {error}
                                </div>
                                <button
                                    type='button'
                                    className='workbench-button-secondary mt-3'
                                    onClick={() =>
                                        setLocalRefreshVersion((v) => v + 1)
                                    }
                                >
                                    {t('web.workspaceFiles.retry')}
                                </button>
                            </div>
                        ) : paths.length === 0 ? (
                            <WorkspaceFilesState>
                                {t('web.workspaceFiles.noFiles', {
                                    root: rootLabel.toLowerCase()
                                })}
                            </WorkspaceFilesState>
                        ) : isSearching && filteredPaths.length === 0 ? (
                            <WorkspaceFilesState>
                                {t('web.workspaceFiles.noMatches', {
                                    query: searchTerm
                                })}
                            </WorkspaceFilesState>
                        ) : (
                            <WorkspaceTree
                                agentId={agent.id}
                                dirErrors={dirErrors}
                                expandedDirs={expandedDirs}
                                filesApi={client.files}
                                isSearching={isSearching}
                                loadedDirs={loadedDirs}
                                loadingDirs={loadingDirs}
                                paths={filteredPaths}
                                rootId={rootId}
                                rootPath={rootPath}
                                rootWritable={selectedRoot.writable}
                                onActionError={reportActionError}
                                onAttachContext={onAttachContext}
                                onExpandedDirectoryChange={
                                    handleExpandedDirectoryChange
                                }
                                onLoadDirectory={handleLoadDirectory}
                                onOpenTerminal={onOpenTerminal}
                                onPreviewPath={handlePreviewPath}
                                onRequestUpload={requestUpload}
                            />
                        )}
                    </div>
                    <input
                        ref={uploadInputRef}
                        type='file'
                        multiple
                        className='hidden'
                        onChange={() => {
                            void handleUploadInputChange()
                        }}
                    />
                    <div className='border-divider/80 text-caption text-placeholder relative hidden min-h-9 shrink-0 items-center justify-between gap-3 border-t px-4 lg:flex'>
                        <div className='flex min-w-0 flex-1 items-center gap-2'>
                            {!loading && !error && paths.length > 0 && (
                                <span className='hidden shrink-0 sm:inline'>
                                    {t('web.workspaceFiles.searchCovers')}
                                </span>
                            )}
                            {loadingDir && (
                                <ShortcutTooltip
                                    label={directoryAbsPath(
                                        rootPath,
                                        loadingDir
                                    )}
                                    placement='top'
                                    className='min-w-0 shrink'
                                >
                                    <span className='w-full truncate'>
                                        {t('web.workspaceFiles.loadingDir', {
                                            name: directoryDisplayName(
                                                loadingDir,
                                                t
                                            )
                                        })}
                                    </span>
                                </ShortcutTooltip>
                            )}
                            {firstDirError && (
                                <span className='min-w-0 shrink truncate'>
                                    <ShortcutTooltip
                                        label={firstDirError.message}
                                        placement='top'
                                        className='mr-2'
                                    >
                                        <span>
                                            {t('web.workspaceFiles.failed', {
                                                name: directoryDisplayName(
                                                    firstDirError.key,
                                                    t
                                                )
                                            })}
                                        </span>
                                    </ShortcutTooltip>
                                    <button
                                        type='button'
                                        className='text-link hover:text-fg font-medium'
                                        onClick={() => {
                                            void handleLoadDirectory(
                                                firstDirError.key
                                            )
                                        }}
                                    >
                                        {t('web.workspaceFiles.retryAction')}
                                    </button>
                                </span>
                            )}
                            {actionError && (
                                <ShortcutTooltip
                                    label={actionError}
                                    placement='top'
                                    className='min-w-0 shrink'
                                >
                                    <span className='w-full truncate text-[#b42318]'>
                                        {actionError}
                                    </span>
                                </ShortcutTooltip>
                            )}
                        </div>
                        <span className='shrink-0 tabular-nums'>
                            {paths.length}
                        </span>
                    </div>
                </aside>
            )}
        </div>
    )
}

interface WorkspaceTreeProps {
    agentId: string
    dirErrors: Record<string, string>
    expandedDirs: Set<string>
    filesApi: FilesClient
    isSearching: boolean
    loadedDirs: Set<string>
    loadingDirs: Set<string>
    onActionError: (err: unknown) => void
    onAttachContext?: (contextRef: WorkspaceFileContextRef) => void
    onExpandedDirectoryChange: (relDir: string, expanded: boolean) => void
    onLoadDirectory: (relDir: string) => void
    onOpenTerminal?: (request: WorkspaceFileTerminalRequest) => void
    onPreviewPath: (path: string) => void
    onRequestUpload: (target: UploadTarget) => void
    paths: string[]
    rootId: string
    rootPath: string
    rootWritable: boolean
}

const WorkspaceTree: FC<WorkspaceTreeProps> = ({
    agentId,
    dirErrors,
    expandedDirs,
    filesApi,
    isSearching,
    loadedDirs,
    loadingDirs,
    onActionError,
    onAttachContext,
    onExpandedDirectoryChange,
    onLoadDirectory,
    onOpenTerminal,
    onPreviewPath,
    onRequestUpload,
    paths,
    rootId,
    rootPath,
    rootWritable
}): ReactNode => {
    const onPreviewPathRef = useRef(onPreviewPath)
    const onLoadDirectoryRef = useRef(onLoadDirectory)
    const onExpandedDirectoryChangeRef = useRef(onExpandedDirectoryChange)
    const loadedDirsRef = useRef(loadedDirs)
    const loadingDirsRef = useRef(loadingDirs)
    const dirErrorsRef = useRef(dirErrors)
    const filePathsRef = useRef<Set<string>>(new Set())
    const previewFilePath = useCallback((path: string): void => {
        if (!filePathsRef.current.has(path)) return
        onPreviewPathRef.current(path)
    }, [])
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
        itemHeight: 30,
        onSelectionChange: (selectedPaths) => {
            const path = selectedPaths.at(-1)
            if (path) previewFilePath(path)
        },
        paths: []
    })
    const filePaths = useMemo(
        () => new Set(paths.filter((path) => !path.endsWith('/'))),
        [paths]
    )
    const directoryPaths = useMemo(
        () => new Set(paths.filter((path) => path.endsWith('/'))),
        [paths]
    )
    const initialExpandedPaths = useMemo(
        () =>
            isSearching
                ? Array.from(directoryPaths)
                : Array.from(expandedDirs)
                      .map(treeDirPathForRelDir)
                      .filter((path) => path && directoryPaths.has(path)),
        [directoryPaths, expandedDirs, isSearching]
    )

    useEffect(() => {
        onPreviewPathRef.current = onPreviewPath
    }, [onPreviewPath])

    useEffect(() => {
        onLoadDirectoryRef.current = onLoadDirectory
    }, [onLoadDirectory])

    useEffect(() => {
        onExpandedDirectoryChangeRef.current = onExpandedDirectoryChange
    }, [onExpandedDirectoryChange])

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
        filePathsRef.current = filePaths
    }, [filePaths])

    useEffect(() => {
        model.resetPaths(paths, { initialExpandedPaths })
        return undefined
    }, [initialExpandedPaths, model, paths, rootPath])

    const syncDirectoryExpansion = useCallback(
        (path: string | null | undefined): void => {
            if (!path) return
            const item = model.getItem(path)
            if (!item?.isDirectory()) return
            if (!('isExpanded' in item)) return
            const relDir = relDirFromTreePath(item.getPath())
            const expanded = item.isExpanded()
            onExpandedDirectoryChangeRef.current(relDir, expanded)
            if (
                expanded &&
                !loadedDirsRef.current.has(relDir) &&
                !loadingDirsRef.current.has(relDir) &&
                !dirErrorsRef.current[relDir]
            ) {
                onLoadDirectoryRef.current(relDir)
            }
        },
        [model]
    )

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
                previewFilePath(path)
                return
            }
            scheduleDirectorySync(path)
        },
        [previewFilePath, scheduleDirectorySync]
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
            id={`workspace-files-${stableId(rootPath)}`}
            model={model}
            onClick={handleTreeClick}
            onKeyDownCapture={handleTreeKeyDown}
            renderContextMenu={(item, menuContext) => (
                <WorkspaceTreeMenu
                    agentId={agentId}
                    filesApi={filesApi}
                    item={item}
                    menuContext={menuContext}
                    rootId={rootId}
                    rootPath={rootPath}
                    rootWritable={rootWritable}
                    onActionError={onActionError}
                    onAttachContext={onAttachContext}
                    onOpenTerminal={onOpenTerminal}
                    onRequestUpload={onRequestUpload}
                />
            )}
            style={FILE_TREE_THEME}
        />
    )
}

interface WorkspaceTreeMenuProps {
    agentId: string
    filesApi: FilesClient
    item: ContextMenuItem
    menuContext: ContextMenuOpenContext
    onActionError: (err: unknown) => void
    onAttachContext?: (contextRef: WorkspaceFileContextRef) => void
    onOpenTerminal?: (request: WorkspaceFileTerminalRequest) => void
    onRequestUpload: (target: UploadTarget) => void
    rootId: string
    rootPath: string
    rootWritable: boolean
}

const WorkspaceTreeMenu: FC<WorkspaceTreeMenuProps> = ({
    agentId,
    filesApi,
    item,
    menuContext,
    onActionError,
    onAttachContext,
    onOpenTerminal,
    onRequestUpload,
    rootId,
    rootPath,
    rootWritable
}): ReactNode => {
    const { t } = useI18n()
    const details = treeMenuDetails(item, rootPath, t)
    const run = (action: () => void | Promise<void>): void => {
        menuContext.close()
        void Promise.resolve(action()).catch(onActionError)
    }

    return (
        <TreeContextMenuPanel
            anchorRect={menuContext.anchorRect}
            title={details.name}
        >
            <TreeMenuItem
                icon={<PaperclipIcon className='h-4 w-4' />}
                label={t('web.workspaceFiles.attachContext')}
                disabled={!onAttachContext}
                onClick={() =>
                    run(() =>
                        onAttachContext?.({
                            path: details.absPath,
                            rootId,
                            name: details.name,
                            entryType: details.entryType
                        })
                    )
                }
            />
            <TreeMenuItem
                icon={<CopyIcon className='h-4 w-4' />}
                label={t('web.workspaceFiles.copyPath')}
                onClick={() => run(() => copyTextToClipboard(details.absPath))}
            />
            <TreeMenuItem
                icon={<CopyIcon className='h-4 w-4' />}
                label={t('web.workspaceFiles.copyRelativePath')}
                onClick={() => run(() => copyTextToClipboard(details.relPath))}
            />
            <TreeMenuItem
                icon={<CopyIcon className='h-4 w-4' />}
                label={t('web.workspaceFiles.copyFilename')}
                onClick={() => run(() => copyTextToClipboard(details.name))}
            />
            <TreeMenuItem
                icon={<TerminalIcon className='h-4 w-4' />}
                label={t('web.workspaceFiles.openInTerminal')}
                disabled={!onOpenTerminal}
                onClick={() =>
                    run(() =>
                        onOpenTerminal?.({
                            cwdPath:
                                details.entryType === 'dir'
                                    ? details.absPath
                                    : dirname(details.absPath),
                            rootId,
                            label: details.terminalLabel
                        })
                    )
                }
            />
            {details.entryType === 'file' && (
                <>
                    <div className='popover-separator' />
                    <TreeMenuItem
                        icon={<DownloadIcon className='h-4 w-4' />}
                        label={t('web.workspaceFiles.downloadFile')}
                        onClick={() =>
                            run(() =>
                                downloadFile(
                                    filesApi,
                                    agentId,
                                    rootId,
                                    details.absPath,
                                    details.name
                                )
                            )
                        }
                    />
                </>
            )}
            {details.entryType === 'dir' && (
                <>
                    <div className='popover-separator' />
                    <TreeMenuItem
                        icon={<UploadIcon className='h-4 w-4' />}
                        label={t('web.workspaceFiles.uploadFile')}
                        disabled={!rootWritable}
                        onClick={() =>
                            run(() =>
                                onRequestUpload({
                                    absPath: details.absPath,
                                    relDir: details.relPath,
                                    rootId
                                })
                            )
                        }
                    />
                </>
            )}
        </TreeContextMenuPanel>
    )
}

interface WorkspaceResizeHandleProps {
    label: string
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
}

const WorkspaceResizeHandle: FC<WorkspaceResizeHandleProps> = ({
    label,
    onPointerDown
}): ReactNode => (
    <div
        aria-label={label}
        aria-orientation='vertical'
        className='group hidden w-2 shrink-0 cursor-col-resize items-stretch justify-center lg:flex'
        role='separator'
        tabIndex={0}
        onPointerDown={onPointerDown}
    >
        <span className='bg-divider group-hover:bg-placeholder group-focus-visible:bg-placeholder h-full w-px transition-colors' />
    </div>
)

const WorkspaceStackResizeHandle: FC<WorkspaceResizeHandleProps> = ({
    label,
    onPointerDown
}): ReactNode => (
    <div
        aria-label={label}
        aria-orientation='horizontal'
        className='group order-2 flex h-8 shrink-0 cursor-row-resize touch-none select-none items-center justify-center lg:hidden'
        role='separator'
        tabIndex={0}
        onPointerDown={onPointerDown}
    >
        <span className='bg-divider group-hover:bg-placeholder h-1 w-16 rounded-full transition-colors' />
    </div>
)

interface WorkspaceFilePreviewProps {
    activeRelPath: string
    agentId: string
    filesApi: FilesClient
    onCloseTab: (path: string) => void
    onSelectTab: (path: string) => void
    treeVisible?: boolean
    onToggleTree?: () => void
    rootId: string
    rootLabel: string
    rootPath: string
    tabs: string[]
}

const WorkspaceFilePreview: FC<WorkspaceFilePreviewProps> = ({
    activeRelPath,
    agentId,
    filesApi,
    onCloseTab,
    onSelectTab,
    treeVisible = true,
    onToggleTree,
    rootId,
    rootLabel,
    rootPath,
    tabs
}): ReactNode => {
    const { t } = useI18n()
    const headerSlot = useContext(SidePaneHeaderSlotContext)
    const [stat, setStat] = useState<FsStatResponse | null>(null)
    const [content, setContent] = useState<PreviewContent>({ kind: 'empty' })
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [rawView, setRawView] = useState(false)
    const absPath = useMemo(
        () => joinPath(rootPath, activeRelPath),
        [activeRelPath, rootPath]
    )
    const fileName = useMemo(() => basename(activeRelPath), [activeRelPath])
    const breadcrumbs = useMemo(
        () => [rootLabel, ...activeRelPath.split('/').filter(Boolean)],
        [activeRelPath, rootLabel]
    )

    useEffect(() => {
        let cancelled = false
        let imageUrl: string | null = null
        const controller = new AbortController()
        setLoading(true)
        setError(null)
        setStat(null)
        setRawView(false)
        setContent({ kind: 'empty' })
        ;(async () => {
            try {
                const nextStat = await filesApi.stat(agentId, absPath, {
                    rootId,
                    signal: controller.signal
                })
                if (cancelled) return
                setStat(nextStat)

                if (nextStat.type !== 'file') {
                    setContent({
                        kind: 'unsupported',
                        reason: t('web.workspaceFiles.previewUnsupported')
                    })
                    return
                }

                if (isPreviewableImage(nextStat)) {
                    if (nextStat.size > MAX_IMAGE_PREVIEW_BYTES) {
                        setContent({
                            kind: 'unsupported',
                            reason: t(
                                'web.workspaceFiles.previewImageTooLarge',
                                { size: formatSize(nextStat.size) }
                            )
                        })
                        return
                    }
                    const res = await filesApi.read(agentId, absPath, {
                        rootId,
                        signal: controller.signal
                    })
                    const blob = await res.blob()
                    if (cancelled) return
                    imageUrl = URL.createObjectURL(blob)
                    setContent({
                        kind: 'image',
                        contentType: nextStat.contentType,
                        url: imageUrl
                    })
                    return
                }

                const ext = extensionOf(activeRelPath)
                const binaryKind = binaryPreviewKind(ext)
                if (binaryKind) {
                    const limit = binaryPreviewLimit(binaryKind)
                    if (nextStat.size > limit) {
                        setContent({
                            kind: 'unsupported',
                            reason: t(
                                'web.workspaceFiles.previewTextTooLarge',
                                { size: formatSize(nextStat.size) }
                            )
                        })
                        return
                    }
                    const res = await filesApi.read(agentId, absPath, {
                        rootId,
                        signal: controller.signal
                    })
                    const data = await res.arrayBuffer()
                    if (cancelled) return
                    if (binaryKind === 'sqlite') {
                        let walWarning = false
                        try {
                            const wal = await filesApi.stat(
                                agentId,
                                `${absPath}-wal`,
                                { rootId, signal: controller.signal }
                            )
                            walWarning = wal.type === 'file' && wal.size > 0
                        } catch {}
                        if (cancelled) return
                        setContent({ kind: 'sqlite', data, walWarning })
                        return
                    }
                    setContent({ kind: binaryKind, data })
                    return
                }

                if (isLegacyExcelExt(ext)) {
                    setContent({
                        kind: 'unsupported',
                        reason: t('web.workspaceFiles.previewXlsUnsupported')
                    })
                    return
                }

                if (!isLikelyText(nextStat, activeRelPath)) {
                    setContent({
                        kind: 'unsupported',
                        reason: t('web.workspaceFiles.previewBinary', {
                            type:
                                nextStat.contentType ||
                                t('web.workspaceFiles.previewBinaryFallback')
                        })
                    })
                    return
                }

                if (nextStat.size > MAX_TEXT_PREVIEW_BYTES) {
                    setContent({
                        kind: 'unsupported',
                        reason: t('web.workspaceFiles.previewTextTooLarge', {
                            size: formatSize(nextStat.size)
                        })
                    })
                    return
                }

                const res = await filesApi.read(agentId, absPath, {
                    rootId,
                    signal: controller.signal
                })
                const text = await res.text()
                if (cancelled) return
                setContent(textPreviewContent(activeRelPath, text))
            } catch (err) {
                if (!cancelled && !controller.signal.aborted)
                    setError(apiErrorMessage(err))
            } finally {
                if (!cancelled && !controller.signal.aborted) setLoading(false)
            }
        })()

        return (): void => {
            cancelled = true
            controller.abort()
            if (imageUrl) URL.revokeObjectURL(imageUrl)
        }
    }, [absPath, activeRelPath, agentId, filesApi, rootId])

    // The open-file tabs live in the shared pane header (portaled into the
    // SidePane header slot), not on their own row — one less bar above the
    // preview. Nothing renders there until the slot element exists.
    const tabBar = (
        <div className='scrollbar-hidden flex min-w-0 flex-1 items-center gap-1 overflow-x-auto'>
            {tabs.map((tab) => {
                const active = tab === activeRelPath
                return (
                    <div
                        key={tab}
                        className={[
                            'text-ui inline-flex h-8 min-w-0 shrink-0 items-center rounded-md transition-colors',
                            active
                                ? 'text-fg shadow-ring-light bg-soft'
                                : 'text-muted hover:text-fg hover:bg-soft'
                        ].join(' ')}
                    >
                        <ShortcutTooltip
                            label={joinPath(rootPath, tab)}
                            className='min-w-0'
                        >
                            <button
                                type='button'
                                className='flex min-w-0 max-w-[14rem] items-center gap-2 px-2.5 font-medium'
                                onClick={() => onSelectTab(tab)}
                            >
                                <FileIcon className='text-placeholder h-4 w-4 shrink-0' />
                                <span className='truncate'>
                                    {basename(tab)}
                                </span>
                            </button>
                        </ShortcutTooltip>
                        <ShortcutTooltip
                            label={t('web.workspaceFiles.previewCloseTab', {
                                name: basename(tab)
                            })}
                            className='shrink-0'
                        >
                            <button
                                type='button'
                                className='text-placeholder rounded-pill hover:bg-surface-hover mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center transition-colors'
                                onClick={() => onCloseTab(tab)}
                            >
                                <CloseIcon className='h-3.5 w-3.5' />
                            </button>
                        </ShortcutTooltip>
                    </div>
                )
            })}
        </div>
    )

    return (
        <section className='border-divider/80 bg-main order-3 flex min-h-0 w-full flex-1 flex-col border-t lg:order-none lg:min-w-0 lg:border-t-0'>
            {headerSlot && createPortal(tabBar, headerSlot)}
            <div className='border-divider/80 text-caption text-muted flex h-11 shrink-0 items-center justify-between gap-3 border-b px-5'>
                <div className='flex min-w-0 items-center gap-1.5'>
                    {breadcrumbs.map((crumb, index) => (
                        <span key={`${crumb}-${index}`} className='contents'>
                            {index > 0 && (
                                <ChevronRightIcon className='text-placeholder h-3.5 w-3.5 shrink-0' />
                            )}
                            <ShortcutTooltip
                                label={
                                    index === breadcrumbs.length - 1
                                        ? absPath
                                        : crumb
                                }
                                className='min-w-0'
                            >
                                <span
                                    className={
                                        index === breadcrumbs.length - 1
                                            ? 'text-fg w-full truncate font-medium'
                                            : 'w-full truncate'
                                    }
                                >
                                    {crumb}
                                </span>
                            </ShortcutTooltip>
                        </span>
                    ))}
                </div>
                <div className='flex shrink-0 items-center gap-1.5'>
                <ShortcutTooltip
                    label={rawToggleTitle(content, rawView, t)}
                    placement='bottom-end'
                    className='shrink-0'
                >
                    <button
                        type='button'
                        className={[
                            'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                            rawView || content.kind === 'text'
                                ? 'text-fg shadow-ring-light bg-soft'
                                : 'text-muted hover:text-fg hover:bg-soft'
                        ].join(' ')}
                        disabled={!RAW_TOGGLE_KINDS.has(content.kind)}
                        onClick={() => setRawView((value) => !value)}
                    >
                        <CodeIcon className='h-3.5 w-3.5' />
                        {t('web.workspaceFiles.previewRaw')}
                    </button>
                </ShortcutTooltip>
                <ShortcutTooltip
                    label={
                        treeVisible
                            ? t('web.workspaceFiles.hideTree')
                            : t('web.workspaceFiles.showTree')
                    }
                    placement='bottom-end'
                    className='shrink-0'
                >
                    <button
                        type='button'
                        onClick={onToggleTree}
                        aria-pressed={!treeVisible}
                        aria-label={
                            treeVisible
                                ? t('web.workspaceFiles.hideTree')
                                : t('web.workspaceFiles.showTree')
                        }
                        className='text-muted hover:bg-surface-hover hover:text-fg inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors'
                    >
                        <SidebarToggleIcon className='h-4 w-4' />
                    </button>
                </ShortcutTooltip>
                </div>
            </div>
            <div className='min-h-0 flex-1 overflow-auto px-8 py-6'>
                {loading ? (
                    <WorkspaceFilesState>
                        <SheenText>
                            {t('web.workspaceFiles.previewLoading')}
                        </SheenText>
                    </WorkspaceFilesState>
                ) : error ? (
                    <div className='workbench-alert-error break-words'>
                        {error}
                    </div>
                ) : (
                    <PreviewErrorBoundary
                        key={`${rootId}:${absPath}`}
                        fallback={
                            <div className='text-ui text-muted flex h-full items-center justify-center text-center'>
                                {t('web.workspaceFiles.previewCrashed')}
                            </div>
                        }
                    >
                        <PreviewBody
                            content={content}
                            fileName={fileName}
                            rawView={rawView}
                        />
                    </PreviewErrorBoundary>
                )}
            </div>
            <div className='border-divider/80 text-caption text-placeholder flex min-h-9 shrink-0 items-center justify-between gap-3 border-t px-5'>
                <ShortcutTooltip
                    label={absPath}
                    placement='top'
                    className='min-w-0'
                >
                    <span className='w-full truncate'>{absPath}</span>
                </ShortcutTooltip>
                {stat && (
                    <span className='shrink-0'>{formatSize(stat.size)}</span>
                )}
            </div>
        </section>
    )
}

interface PreviewBodyProps {
    content: PreviewContent
    fileName: string
    rawView: boolean
}

const PreviewBody: FC<PreviewBodyProps> = ({
    content,
    fileName,
    rawView
}): ReactNode => {
    if (content.kind === 'markdown' && !rawView)
        return <MarkdownText text={content.text} />
    if (content.kind === 'code' && !rawView)
        return <CodePreview text={content.text} language={content.language} />
    if (content.kind === 'csv' && !rawView)
        return <CsvPreview text={content.text} />
    if (content.kind === 'html' && !rawView)
        return <HtmlPreview html={content.text} title={fileName} />
    if (
        content.kind === 'markdown' ||
        content.kind === 'text' ||
        content.kind === 'code' ||
        content.kind === 'csv' ||
        content.kind === 'html'
    )
        return (
            <pre className='text-caption text-fg whitespace-pre-wrap break-words font-mono leading-6'>
                {content.text || ' '}
            </pre>
        )
    if (content.kind === 'docx')
        return <DocxPreview data={content.data} title={fileName} />
    if (content.kind === 'xlsx') return <XlsxPreview data={content.data} />
    if (content.kind === 'sqlite')
        return (
            <SqlitePreview
                data={content.data}
                walWarning={content.walWarning}
            />
        )
    if (content.kind === 'image')
        return (
            <div className='flex h-full min-h-[18rem] items-center justify-center'>
                <img
                    src={content.url}
                    alt={fileName}
                    className='shadow-ring-light max-h-full max-w-full rounded-md object-contain'
                />
            </div>
        )
    if (content.kind === 'unsupported')
        return (
            <div className='text-ui text-muted flex h-full items-center justify-center text-center'>
                {content.reason}
            </div>
        )
    return null
}

// Ghost rows for the pending file tree (DESIGN.md §10.8).
const ghostFileWidth = ['w-2/3', 'w-1/2', 'w-4/5', 'w-2/5', 'w-3/5']
const GHOST_FILE_ROWS = [0, 1, 2, 3, 4, 5, 6]

interface WorkspaceFilesStateProps {
    children: ReactNode
}

const WorkspaceFilesState: FC<WorkspaceFilesStateProps> = ({
    children
}): ReactNode => (
    <div className='text-ui text-muted flex h-full items-center justify-center px-6 text-center'>
        {children}
    </div>
)

interface WorkspaceRootPickerProps {
    roots: FileRootSdk[]
    selectedRootId: string
    onSelect: (rootId: string) => void
}

const WorkspaceRootPicker: FC<WorkspaceRootPickerProps> = ({
    roots,
    selectedRootId,
    onSelect
}): ReactNode => {
    const { t } = useI18n()
    const [open, setOpen] = useState(false)
    const wrapperRef = useRef<HTMLDivElement | null>(null)
    const selected = roots.find((r) => r.id === selectedRootId) ?? roots[0]
    const hasMultiple = roots.length > 1

    useEffect(() => {
        if (!open) return
        const onDocPointer = (event: PointerEvent): void => {
            if (!wrapperRef.current) return
            if (wrapperRef.current.contains(event.target as Node)) return
            setOpen(false)
        }
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onDocPointer)
        document.addEventListener('keydown', onKey)
        return (): void => {
            document.removeEventListener('pointerdown', onDocPointer)
            document.removeEventListener('keydown', onKey)
        }
    }, [open])

    if (!selected) return null

    if (!hasMultiple)
        return (
            <ShortcutTooltip
                label={selected.path}
                placement='bottom-start'
                className='min-w-0 max-w-full'
            >
                <span className='w-full truncate'>{selected.path}</span>
            </ShortcutTooltip>
        )

    return (
        <div ref={wrapperRef} className='relative min-w-0 flex-1'>
            <ShortcutTooltip
                label={`${selected.label} — ${selected.path}`}
                placement='bottom-start'
                className='w-full min-w-0'
            >
                <button
                    type='button'
                    aria-haspopup='listbox'
                    aria-expanded={open}
                    onClick={() => setOpen((v) => !v)}
                    className='hover:text-fg flex w-full min-w-0 max-w-full items-center gap-1.5 truncate text-left transition-colors'
                >
                    <span className='truncate'>{selected.path}</span>
                    <ChevronDownIcon className='h-3 w-3 shrink-0' />
                </button>
            </ShortcutTooltip>
            {open && (
                <div
                    role='listbox'
                    className='popover-panel border-divider/80 bg-surface-elevated shadow-elevated absolute left-0 right-0 top-full z-20 mt-1 max-h-[60vh] overflow-y-auto overflow-x-hidden rounded-md border p-1'
                >
                    {roots.map((root) => {
                        const active = root.id === selectedRootId
                        return (
                            <button
                                key={root.id}
                                type='button'
                                role='option'
                                aria-selected={active}
                                onClick={() => {
                                    onSelect(root.id)
                                    setOpen(false)
                                }}
                                className='text-fg hover:bg-soft flex w-full flex-col items-start gap-0.5 rounded-sm px-2.5 py-1.5 text-left transition-colors'
                            >
                                <span className='text-ui flex w-full items-center justify-between gap-2 font-medium'>
                                    <span className='truncate'>
                                        {root.label}
                                    </span>
                                    <span className='flex shrink-0 items-center gap-2'>
                                        {!root.writable && (
                                            <span className='text-caption text-placeholder'>
                                                {t(
                                                    'web.workspaceFiles.readOnly'
                                                )}
                                            </span>
                                        )}
                                        {active && (
                                            <CheckIcon className='text-link h-3.5 w-3.5' />
                                        )}
                                    </span>
                                </span>
                                <span className='text-caption text-placeholder w-full truncate font-mono'>
                                    {root.path}
                                </span>
                            </button>
                        )
                    })}
                </div>
            )}
        </div>
    )
}

const loadDirectoryEntries = async (
    filesApi: FilesClient,
    agentId: string,
    absPath: string,
    rootId: string,
    relDir: string,
    signal?: AbortSignal
): Promise<string[]> => {
    const paths: string[] = []
    const entries = (await filesApi.list(agentId, absPath, { rootId, signal }))
        .entries

    for (const entry of sortEntries(entries)) {
        if (!entry.name) continue
        const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
        paths.push(entry.type === 'dir' ? `${relPath}/` : relPath)
    }

    return paths
}

const mergeKnownPaths = (current: string[], additions: string[]): string[] => {
    const seen = new Set(current)
    const next = [...current]
    for (const path of additions) {
        if (seen.has(path)) continue
        seen.add(path)
        next.push(path)
    }
    return next
}

const directoryAbsPath = (rootPath: string, relDir: string): string =>
    relDir ? joinPath(rootPath, relDir) : rootPath

const normalizeRelDir = (path: string): string => path.replace(/^\/+|\/+$/g, '')

const relDirFromTreePath = (path: string): string => normalizeRelDir(path)

const treeDirPathForRelDir = (relDir: string): string =>
    relDir ? `${relDir}/` : ''

const directoryDisplayName = (relDir: string, t: TFn): string =>
    relDir ? basename(relDir) : t('web.workspaceFiles.directoryRoot')

const treeMenuDetails = (
    item: ContextMenuItem,
    rootPath: string,
    t: TFn
): {
    absPath: string
    entryType: 'file' | 'dir'
    name: string
    relPath: string
    terminalLabel: string
} => {
    const relPath = normalizeTreeItemPath(item.path)
    const absPath = joinPath(rootPath, relPath)
    const name = basename(relPath)
    const entryType = item.kind === 'directory' ? 'dir' : 'file'
    return {
        absPath,
        entryType,
        name,
        relPath,
        terminalLabel: t('web.workspaceFiles.terminalLabel', {
            name: entryType === 'dir' ? name : basename(dirname(absPath))
        })
    }
}

const normalizeTreeItemPath = (path: string): string =>
    path.replace(/^\/+|\/+$/g, '')

const dirname = (path: string): string => {
    const normalized = normalizeAbsPath(path)
    if (normalized === '/') return '/'
    const parts = normalized.split('/').filter(Boolean)
    parts.pop()
    return parts.length === 0 ? '/' : `/${parts.join('/')}`
}

const firstSetValue = <T,>(set: Set<T>): T | null =>
    set.values().next().value ?? null

const firstRecordEntry = (
    record: Record<string, string>
): { key: string; message: string } | null => {
    const first = Object.entries(record)[0]
    return first ? { key: first[0], message: first[1] } : null
}

const omitRecordKey = <T,>(
    record: Record<string, T>,
    key: string
): Record<string, T> => {
    if (!(key in record)) return record
    const next = { ...record }
    delete next[key]
    return next
}

const sortEntries = (entries: FsEntrySdk[]): FsEntrySdk[] =>
    [...entries].sort((a, b) => {
        const aDir = a.type === 'dir'
        const bDir = b.type === 'dir'
        if (aDir !== bDir) return aDir ? -1 : 1
        return a.name.localeCompare(b.name, undefined, {
            numeric: true,
            sensitivity: 'base'
        })
    })

const normalizeAbsPath = (path: string): string => {
    const trimmed = path.trim()
    const abs = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
    const normalized = abs.replace(/\/+$/, '')
    return normalized || '/'
}

const joinPath = (dir: string, name: string): string => {
    if (dir === '/') return `/${name}`
    return `${dir.replace(/\/+$/, '')}/${name}`
}

const basename = (path: string): string => {
    const parts = path.split('/').filter(Boolean)
    return parts.at(-1) ?? '/'
}

const extensionOf = (path: string): string => {
    const name = basename(path).toLowerCase()
    if (name === 'dockerfile') return 'dockerfile'
    const idx = name.lastIndexOf('.')
    return idx === -1 ? '' : name.slice(idx + 1)
}

const isMarkdownPath = (path: string): boolean =>
    MARKDOWN_EXTENSIONS.has(extensionOf(path))

const isLikelyText = (stat: FsStatResponse, path: string): boolean => {
    const contentType = stat.contentType.toLowerCase()
    if (contentType.startsWith('text/')) return true
    if (
        /^(application\/(json|javascript|xml|x-sh|x-yaml|yaml|toml|x-ndjson))|\+json|\+xml/.test(
            contentType
        )
    )
        return true
    return TEXT_EXTENSIONS.has(extensionOf(path)) || isMarkdownPath(path)
}

const isPreviewableImage = (stat: FsStatResponse): boolean =>
    stat.contentType.toLowerCase().startsWith('image/')

const formatSize = (n: number): string => {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max)

const stableId = (value: string): string =>
    value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') ||
    'workspace'

const ROOT_STORAGE_PREFIX = 'workspace-files-root:'

const readStoredRoot = (agentId: string): string | null => {
    if (typeof window === 'undefined') return null
    try {
        return window.localStorage.getItem(`${ROOT_STORAGE_PREFIX}${agentId}`)
    } catch {
        return null
    }
}

const writeStoredRoot = (agentId: string, rootId: string): void => {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(`${ROOT_STORAGE_PREFIX}${agentId}`, rootId)
    } catch {}
}

const textPreviewContent = (relPath: string, text: string): PreviewContent => {
    if (isMarkdownPath(relPath)) return { kind: 'markdown', text }
    const ext = extensionOf(relPath)
    if (ext === 'csv') return { kind: 'csv', text }
    if (isHtmlExt(ext)) return { kind: 'html', text }
    const language = codeLanguageFor(ext)
    if (language) return { kind: 'code', text, language }
    return { kind: 'text', text }
}

const rawToggleTitle = (
    content: PreviewContent,
    rawView: boolean,
    t: TFn
): string => {
    if (RAW_TOGGLE_KINDS.has(content.kind))
        return rawView
            ? t('web.workspaceFiles.rawToggleShowRendered')
            : t('web.workspaceFiles.rawToggleShowRaw')
    if (content.kind === 'text')
        return t('web.workspaceFiles.rawToggleAlreadyRaw')
    return t('web.workspaceFiles.rawToggleUnavailable')
}

export default WorkspaceFiles
