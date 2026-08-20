import type { FsEntrySdk } from '@manyfold/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FilesClient } from '@manyfold/sdk'

export interface AgentFileTree {
    paths: string[]
    expandedDirs: Set<string>
    loadedDirs: Set<string>
    loadingDirs: Set<string>
    dirErrors: Record<string, string>
    loading: boolean
    error: string | null
    loadDirectory: (relDir: string) => void
    setExpanded: (relDir: string, expanded: boolean) => void
    refreshDir: (relDir: string) => Promise<void>
    reload: () => void
}

export const normalizeAbsPath = (path: string): string => {
    const trimmed = path.trim()
    const abs = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
    return abs.replace(/\/+$/, '') || '/'
}

export const joinPath = (dir: string, name: string): string => {
    if (dir === '/') return `/${name}`
    return `${dir.replace(/\/+$/, '')}/${name}`
}

export const basename = (path: string): string => {
    const parts = path.split('/').filter(Boolean)
    return parts.at(-1) ?? '/'
}

export const normalizeRelDir = (path: string): string =>
    path.replace(/^\/+|\/+$/g, '')

export const treeDirPathForRelDir = (relDir: string): string =>
    relDir ? `${relDir}/` : ''

export const relDirOf = (relPath: string): string => {
    const normalized = normalizeRelDir(relPath)
    const idx = normalized.lastIndexOf('/')
    return idx === -1 ? '' : normalized.slice(0, idx)
}

export const directoryAbsPath = (rootPath: string, relDir: string): string =>
    relDir ? joinPath(rootPath, relDir) : rootPath

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

const loadDirectoryEntries = async (
    filesApi: FilesClient,
    agentId: string,
    absPath: string,
    rootId: string,
    relDir: string,
    signal?: AbortSignal
): Promise<string[]> => {
    const res = await filesApi.list(agentId, absPath, { rootId, signal })
    const paths: string[] = []
    for (const entry of sortEntries(res.entries)) {
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

// A refreshed listing is authoritative for its own level: direct children are
// replaced wholesale, and deeper paths survive only while the child directory
// they hang off of still exists (so renames and deletes do not leave ghosts).
const replaceDirEntries = (
    current: string[],
    relDir: string,
    children: string[]
): string[] => {
    const prefix = treeDirPathForRelDir(relDir)
    const childSet = new Set(children)
    const kept = current.filter((path) => {
        if (prefix && !path.startsWith(prefix)) return true
        if (path === prefix) return true
        const rest = path.slice(prefix.length)
        const slash = rest.indexOf('/')
        if (slash === -1) return false
        return childSet.has(`${prefix}${rest.slice(0, slash + 1)}`)
    })
    return mergeKnownPaths(kept, children)
}

const pruneTracking = (
    tracked: Set<string>,
    pathSet: Set<string>
): Set<string> => {
    const next = new Set<string>()
    for (const relDir of tracked) {
        if (!relDir || pathSet.has(treeDirPathForRelDir(relDir)))
            next.add(relDir)
    }
    return next
}

const omitRecordKey = <T>(
    record: Record<string, T>,
    key: string
): Record<string, T> => {
    if (!(key in record)) return record
    const next = { ...record }
    delete next[key]
    return next
}

export const useAgentFileTree = (
    filesApi: FilesClient,
    agentId: string,
    rootId: string,
    rootPath: string,
    enabled: boolean
): AgentFileTree => {
    const [paths, setPaths] = useState<string[]>([])
    const [loading, setLoading] = useState(enabled)
    const [error, setError] = useState<string | null>(null)
    const [loadedDirs, setLoadedDirs] = useState<Set<string>>(() => new Set())
    const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set())
    const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
        () => new Set()
    )
    const [dirErrors, setDirErrors] = useState<Record<string, string>>({})
    const [reloadVersion, setReloadVersion] = useState(0)

    const loadedDirsRef = useRef<Set<string>>(new Set())
    const loadingDirsRef = useRef<Set<string>>(new Set())
    const pathsRef = useRef<string[]>([])
    const generationRef = useRef(0)
    const controllersRef = useRef<Set<AbortController>>(new Set())

    // pathsRef is the authoritative copy: sequential mutations (upload then
    // refresh, rename then refresh) read it before React has re-rendered.
    const applyPaths = useCallback((next: string[]): void => {
        pathsRef.current = next
        setPaths(next)
    }, [])

    const reload = useCallback((): void => {
        setReloadVersion((v) => v + 1)
    }, [])

    const setExpanded = useCallback(
        (relDirInput: string, expanded: boolean): void => {
            const relDir = normalizeRelDir(relDirInput)
            setExpandedDirs((prev) => {
                if (prev.has(relDir) === expanded) return prev
                const next = new Set(prev)
                if (expanded) next.add(relDir)
                else next.delete(relDir)
                return next
            })
        },
        []
    )

    useEffect(() => {
        return (): void => {
            generationRef.current += 1
            for (const controller of controllersRef.current) controller.abort()
            controllersRef.current.clear()
        }
    }, [])

    useEffect(() => {
        const generation = generationRef.current + 1
        generationRef.current = generation
        for (const controller of controllersRef.current) controller.abort()
        controllersRef.current.clear()
        loadedDirsRef.current = new Set()
        loadingDirsRef.current = new Set()
        setLoadedDirs(new Set())
        setLoadingDirs(new Set())
        setExpandedDirs(new Set())
        setDirErrors({})
        applyPaths([])
        setError(null)

        if (!enabled) {
            setLoading(false)
            return
        }

        const controller = new AbortController()
        controllersRef.current.add(controller)
        setLoading(true)
        loadDirectoryEntries(
            filesApi,
            agentId,
            rootPath,
            rootId,
            '',
            controller.signal
        )
            .then((rootPaths) => {
                if (generationRef.current !== generation) return
                loadedDirsRef.current = new Set([''])
                setLoadedDirs(new Set(['']))
                applyPaths(rootPaths)
            })
            .catch((err) => {
                if (
                    controller.signal.aborted ||
                    generationRef.current !== generation
                )
                    return
                setError((err as Error).message)
            })
            .finally(() => {
                controllersRef.current.delete(controller)
                if (
                    !controller.signal.aborted &&
                    generationRef.current === generation
                )
                    setLoading(false)
            })

        return (): void => {
            controller.abort()
        }
    }, [
        agentId,
        applyPaths,
        enabled,
        filesApi,
        reloadVersion,
        rootId,
        rootPath
    ])

    const listDir = useCallback(
        async (relDir: string): Promise<string[] | null> => {
            const generation = generationRef.current
            const nextLoading = new Set(loadingDirsRef.current)
            nextLoading.add(relDir)
            loadingDirsRef.current = nextLoading
            setLoadingDirs(nextLoading)
            setDirErrors((prev) => omitRecordKey(prev, relDir))

            const controller = new AbortController()
            controllersRef.current.add(controller)
            try {
                const children = await loadDirectoryEntries(
                    filesApi,
                    agentId,
                    directoryAbsPath(rootPath, relDir),
                    rootId,
                    relDir,
                    controller.signal
                )
                if (generationRef.current !== generation) return null
                return children
            } catch (err) {
                if (
                    controller.signal.aborted ||
                    generationRef.current !== generation
                )
                    return null
                setDirErrors((prev) => ({
                    ...prev,
                    [relDir]: (err as Error).message
                }))
                return null
            } finally {
                controllersRef.current.delete(controller)
                if (
                    !controller.signal.aborted &&
                    generationRef.current === generation
                ) {
                    const remaining = new Set(loadingDirsRef.current)
                    remaining.delete(relDir)
                    loadingDirsRef.current = remaining
                    setLoadingDirs(remaining)
                }
            }
        },
        [agentId, filesApi, rootId, rootPath]
    )

    const markLoaded = useCallback((relDir: string): void => {
        const next = new Set(loadedDirsRef.current)
        next.add(relDir)
        loadedDirsRef.current = next
        setLoadedDirs(next)
    }, [])

    const loadDirectory = useCallback(
        (relDirInput: string): void => {
            const relDir = normalizeRelDir(relDirInput)
            if (!enabled) return
            if (
                loadedDirsRef.current.has(relDir) ||
                loadingDirsRef.current.has(relDir)
            )
                return
            void listDir(relDir).then((children) => {
                if (!children) return
                applyPaths(mergeKnownPaths(pathsRef.current, children))
                markLoaded(relDir)
            })
        },
        [applyPaths, enabled, listDir, markLoaded]
    )

    const refreshDir = useCallback(
        async (relDirInput: string): Promise<void> => {
            const relDir = normalizeRelDir(relDirInput)
            if (!enabled) return
            const children = await listDir(relDir)
            if (!children) return
            const nextPaths = replaceDirEntries(
                pathsRef.current,
                relDir,
                children
            )
            const pathSet = new Set(nextPaths)
            applyPaths(nextPaths)
            const nextLoaded = pruneTracking(
                new Set([...loadedDirsRef.current, relDir]),
                pathSet
            )
            loadedDirsRef.current = nextLoaded
            setLoadedDirs(nextLoaded)
            setExpandedDirs((prev) => pruneTracking(prev, pathSet))
        },
        [applyPaths, enabled, listDir]
    )

    return {
        paths,
        expandedDirs,
        loadedDirs,
        loadingDirs,
        dirErrors,
        loading,
        error,
        loadDirectory,
        setExpanded,
        refreshDir,
        reload
    }
}
