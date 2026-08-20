import {
    MAX_LIBRARY_SKILL_FILE_COUNT,
    MAX_LIBRARY_SKILL_TOTAL_BYTES,
    validateLibraryFilePath
} from '@manyfold/shared'
import type {
    LibrarySkillDetail,
    LibrarySkillOriginType,
    UpdateLibrarySkillBody
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError } from '@manyfold/sdk'
import EmptyState from '@/components/EmptyState'
import { Tag } from '@/components/Tag'
import MarkdownText from '@/components/chat/MarkdownText'
import {
    ArrowLeftIcon,
    DownloadIcon,
    EditIcon,
    FileExportIcon,
    HistoryIcon,
    PlusIcon,
    ShareIcon,
    SkillsIcon,
    TrashIcon,
    UploadIcon
} from '@/components/icons'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import { useApiClient } from '@/lib/apiClient'
import { Ghost, Spinner } from '@/components/Loading'
import { formatDate } from '@/lib/dateFormat'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'
import { useCurrentUserAvatar } from '@/lib/useCurrentUserAvatar'
import LibraryInstallDialog from './LibraryInstallDialog'
import ShareSkillDialog from './ShareSkillDialog'
import SkillFileTree, {
    SKILL_MD_KEY,
    type SkillTreeActions
} from './LibrarySkillFileTree'
import SkillPathDialog from './SkillPathDialog'
import {
    baseName,
    draftPathConflict,
    joinRelPath,
    readSkillTextFile,
    utf8ByteLength
} from './librarySkillFileUtils'

interface DraftFile {
    key: string
    fileId: string | null
    path: string
    content: string
}

const downloadBlob = (blob: Blob, filename: string): void => {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

// The delete 409 carries the authoritative installed-agent list in
// error.details; the detail count is the fallback when it is absent.
const installedCountFromError = (err: ApiError, fallback: number): number => {
    const details = err.details as { installedAgentIds?: unknown } | undefined
    const ids = details?.installedAgentIds
    return Array.isArray(ids) && ids.length > 0 ? ids.length : fallback
}

const modeTabClass = (active: boolean): string =>
    [
        'text-caption inline-flex h-7 items-center rounded-sm px-2.5 font-medium transition-colors',
        active
            ? 'bg-surface text-fg shadow-ring-light'
            : 'text-muted hover:bg-surface-hover'
    ].join(' ')

const ORIGIN_LABEL_KEY: Record<LibrarySkillOriginType, string> = {
    manual: 'web.skills.library.originManual',
    github: 'web.skills.library.originGithub',
    archive: 'web.skills.library.originArchive',
    catalog: 'web.skills.library.originCatalog',
    share: 'web.skills.library.originShare'
}

// Library content keeps its raw SKILL.md, frontmatter and all; the read view
// strips a leading YAML block so the rendered prose matches the catalog page
// (whose server-side body is already stripped). Editing still sees the raw file.
const stripFrontmatter = (md: string): string =>
    md.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '')

// Tertiary actions in the read rail are ghost buttons (DESIGN.md §8.9 class G):
// transparent at rest, a soft Sm-10 fill only on hover — one tier quieter than
// the outline Edit above. Each carries a leading icon so it reads as an action
// even at rest (a bare label was too weak to look clickable), at the 13px / h-8
// working size. Delete composes this base with the danger hue and is pushed to
// the far edge so the destructive action reads as separate, not adjacent.
const CARD_GHOST_BASE =
    'text-ui rounded-sm inline-flex h-8 shrink-0 items-center gap-1.5 px-2.5 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50'

const LibrarySkillEditor: FC = (): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const navigate = useNavigate()
    const { confirm, confirmDialog } = useProductConfirm()
    const userAvatar = useCurrentUserAvatar()
    const [searchParams] = useSearchParams()
    const skillId = searchParams.get('id') ?? ''
    const wantEdit = searchParams.get('edit') === '1'
    const newFileSeq = useRef(0)

    const [detail, setDetail] = useState<LibrarySkillDetail | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [content, setContent] = useState('')
    const [files, setFiles] = useState<DraftFile[]>([])
    const [deletedIds, setDeletedIds] = useState<string[]>([])
    const [selected, setSelected] = useState(SKILL_MD_KEY)
    const [mode, setMode] = useState<'edit' | 'preview'>('edit')
    const [editing, setEditing] = useState(false)
    const [addPath, setAddPath] = useState('')
    const [addingFile, setAddingFile] = useState(false)
    const [saving, setSaving] = useState(false)
    const [busy, setBusy] = useState(false)
    const [savedFlash, setSavedFlash] = useState(false)
    const [installOpen, setInstallOpen] = useState(false)
    const [shareOpen, setShareOpen] = useState(false)
    const [pushNote, setPushNote] = useState<string | null>(null)
    const [renameTarget, setRenameTarget] = useState<
        | { kind: 'file'; key: string; path: string }
        | { kind: 'dir'; path: string }
        | null
    >(null)
    const uploadInputRef = useRef<HTMLInputElement | null>(null)
    const uploadDirRef = useRef('')
    const addPathInputRef = useRef<HTMLInputElement | null>(null)

    const seed = (next: LibrarySkillDetail): void => {
        setDetail(next)
        setName(next.name)
        setDescription(next.description ?? '')
        setContent(next.content)
        setFiles(
            next.files.map((file) => ({
                key: file.id,
                fileId: file.id,
                path: file.path,
                content: file.content
            }))
        )
        setDeletedIds([])
    }

    useEffect(() => {
        if (!skillId) {
            setLoading(false)
            return
        }
        let cancelled = false
        setLoading(true)
        setDetail(null)
        setSelected(SKILL_MD_KEY)
        setMode('edit')
        client.skills.library
            .get(skillId)
            .then((next) => {
                if (cancelled) return
                seed(next)
                // View-first: only open straight into the editor when there is
                // nothing to read yet (a fresh blank skill) or the caller asked
                // for it explicitly (?edit=1). Imported/copied skills carry
                // content, so they land in the read view.
                const blank =
                    next.content.trim() === '' && next.files.length === 0
                setEditing(wantEdit || blank)
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
    }, [client, skillId, wantEdit])

    useEffect(() => {
        if (!savedFlash) return
        const timer = window.setTimeout(() => setSavedFlash(false), 2500)
        return () => window.clearTimeout(timer)
    }, [savedFlash])

    const serverFileById = useMemo(() => {
        const map = new Map<string, string>()
        for (const file of detail?.files ?? []) map.set(file.id, file.content)
        return map
    }, [detail])

    const dirty = useMemo(() => {
        if (!detail) return false
        if (name !== detail.name) return true
        if (description !== (detail.description ?? '')) return true
        if (content !== detail.content) return true
        if (deletedIds.length > 0) return true
        return files.some(
            (file) =>
                !file.fileId || serverFileById.get(file.fileId) !== file.content
        )
    }, [detail, name, description, content, deletedIds, files, serverFileById])

    const selectedFile =
        selected === SKILL_MD_KEY
            ? null
            : (files.find((file) => file.key === selected) ?? null)
    const selectedPath = selectedFile ? selectedFile.path : SKILL_MD_KEY
    const selectedContent = selectedFile ? selectedFile.content : content
    const isMarkdown = selectedPath.toLowerCase().endsWith('.md')

    const viewDocs = useMemo(
        () => [
            { key: SKILL_MD_KEY, path: SKILL_MD_KEY, content },
            ...files.map((file) => ({
                key: file.key,
                path: file.path,
                content: file.content
            }))
        ],
        [content, files]
    )
    const viewBody = isMarkdown
        ? stripFrontmatter(selectedContent)
        : selectedContent

    const selectEntry = (key: string, path: string): void => {
        setSelected(key)
        if (!path.toLowerCase().endsWith('.md')) setMode('edit')
    }

    const selectPath = (path: string): void => {
        if (path === SKILL_MD_KEY) {
            selectEntry(SKILL_MD_KEY, SKILL_MD_KEY)
            return
        }
        const file = files.find((candidate) => candidate.path === path)
        if (file) selectEntry(file.key, file.path)
    }

    const updateSelectedContent = (value: string): void => {
        if (!selectedFile) {
            setContent(value)
            return
        }
        setFiles((prev) =>
            prev.map((file) =>
                file.key === selectedFile.key
                    ? { ...file, content: value }
                    : file
            )
        )
    }

    const pathProblemMessage = (
        candidate: string,
        otherPaths: readonly string[]
    ): string | null => {
        const result = validateLibraryFilePath(candidate)
        if (!result.valid)
            return t(
                result.code === 'reserved'
                    ? 'web.skills.library.pathReserved'
                    : 'web.skills.library.pathInvalid'
            )
        const conflict = draftPathConflict(otherPaths, result.value)
        if (conflict === 'file')
            return t('web.skills.library.pathExists', { path: result.value })
        if (conflict === 'dir')
            return t('web.skills.library.pathConflictsDir', {
                path: result.value
            })
        return null
    }

    const addFile = (): void => {
        const raw = addPath.trim()
        if (!raw) return
        const existing = files.find((file) => file.path === raw)
        if (existing) {
            selectEntry(existing.key, existing.path)
            setAddPath('')
            setAddingFile(false)
            return
        }
        const problem = pathProblemMessage(raw, [
            SKILL_MD_KEY,
            ...files.map((file) => file.path)
        ])
        if (problem) {
            setError(problem)
            return
        }
        const path = validateLibraryFilePath(raw)
        if (!path.valid) return
        newFileSeq.current += 1
        const key = `new-${newFileSeq.current}`
        setFiles((prev) => [
            ...prev,
            { key, fileId: null, path: path.value, content: '' }
        ])
        selectEntry(key, path.value)
        setAddPath('')
        setAddingFile(false)
        setError(null)
    }

    const removeFile = (target: DraftFile): void => {
        const fileId = target.fileId
        if (fileId) setDeletedIds((prev) => [...prev, fileId])
        setFiles((prev) => prev.filter((file) => file.key !== target.key))
        if (selected === target.key) {
            setSelected(SKILL_MD_KEY)
            setMode('edit')
        }
    }

    const removeFolder = async (dirPath: string): Promise<void> => {
        const prefix = `${dirPath}/`
        const affected = files.filter((file) => file.path.startsWith(prefix))
        if (affected.length === 0) return
        const confirmed = await confirm({
            title: t('web.skills.library.deleteFolder'),
            description: t('web.skills.library.deleteFolderConfirm', {
                name: baseName(dirPath),
                count: affected.length
            }),
            confirmLabel: t('web.skills.library.delete'),
            cancelLabel: t('common.cancel'),
            tone: 'danger'
        })
        if (!confirmed) return
        const affectedKeys = new Set(affected.map((file) => file.key))
        const removedIds = affected
            .map((file) => file.fileId)
            .filter((id): id is string => Boolean(id))
        if (removedIds.length > 0)
            setDeletedIds((prev) => [...prev, ...removedIds])
        setFiles((prev) => prev.filter((file) => !affectedKeys.has(file.key)))
        if (affectedKeys.has(selected)) {
            setSelected(SKILL_MD_KEY)
            setMode('edit')
        }
    }

    const downloadEntry = (path: string): void => {
        if (path === SKILL_MD_KEY) {
            downloadBlob(
                new Blob([content], { type: 'text/markdown;charset=utf-8' }),
                SKILL_MD_KEY
            )
            return
        }
        const file = files.find((candidate) => candidate.path === path)
        if (!file) return
        downloadBlob(
            new Blob([file.content], { type: 'text/plain;charset=utf-8' }),
            baseName(path)
        )
    }

    const newFileHere = (dirPath: string): void => {
        setAddPath(`${dirPath}/`)
        setAddingFile(true)
        window.setTimeout(() => addPathInputRef.current?.focus(), 0)
    }

    const requestUpload = (dirPath: string): void => {
        uploadDirRef.current = dirPath
        uploadInputRef.current?.click()
    }

    const handleUploadFiles = async (): Promise<void> => {
        const input = uploadInputRef.current
        const picked = Array.from(input?.files ?? [])
        if (input) input.value = ''
        const dir = uploadDirRef.current
        uploadDirRef.current = ''
        if (picked.length === 0) return

        const rejectedLines: string[] = []
        const accepted: Array<{
            path: string
            text: string
            overwrite: boolean
        }> = []
        const existingPaths = [SKILL_MD_KEY, ...files.map((file) => file.path)]

        for (const file of picked) {
            const candidate = joinRelPath(dir, file.name)
            const result = validateLibraryFilePath(candidate)
            if (!result.valid) {
                rejectedLines.push(
                    `${file.name}: ${t(
                        result.code === 'reserved'
                            ? 'web.skills.library.pathReserved'
                            : 'web.skills.library.pathInvalid'
                    )}`
                )
                continue
            }
            const conflict = draftPathConflict(existingPaths, result.value)
            if (conflict === 'dir') {
                rejectedLines.push(
                    t('web.skills.library.pathConflictsDir', {
                        path: result.value
                    })
                )
                continue
            }
            const read = await readSkillTextFile(file)
            if (!read.ok) {
                rejectedLines.push(
                    t(
                        read.code === 'binary'
                            ? 'web.skills.library.uploadBinary'
                            : 'web.skills.library.uploadTooLarge',
                        { name: file.name }
                    )
                )
                continue
            }
            accepted.push({
                path: result.value,
                text: read.text,
                overwrite: conflict === 'file'
            })
        }

        let toApply = accepted
        const overwrites = accepted.filter((entry) => entry.overwrite)
        if (overwrites.length > 0) {
            const confirmed = await confirm({
                title: t('web.skills.library.uploadOverwriteTitle'),
                description: t('web.skills.library.uploadOverwriteBody', {
                    count: overwrites.length,
                    paths: overwrites.map((entry) => entry.path).join(', ')
                }),
                confirmLabel: t('web.skills.library.conflictOverwrite'),
                cancelLabel: t('common.cancel')
            })
            if (!confirmed)
                toApply = accepted.filter((entry) => !entry.overwrite)
        }

        let batchError: string | null = null
        const newOnes = toApply.filter((entry) => !entry.overwrite)
        if (files.length + newOnes.length > MAX_LIBRARY_SKILL_FILE_COUNT) {
            batchError = t('web.skills.library.uploadTooMany', {
                count: MAX_LIBRARY_SKILL_FILE_COUNT
            })
            toApply = []
        } else if (toApply.length > 0) {
            const overwrittenPaths = new Set(
                toApply
                    .filter((entry) => entry.overwrite)
                    .map((entry) => entry.path)
            )
            const baseBytes =
                utf8ByteLength(content) +
                files.reduce(
                    (sum, file) =>
                        overwrittenPaths.has(file.path)
                            ? sum
                            : sum + utf8ByteLength(file.content),
                    0
                )
            const addedBytes = toApply.reduce(
                (sum, entry) => sum + utf8ByteLength(entry.text),
                0
            )
            if (baseBytes + addedBytes > MAX_LIBRARY_SKILL_TOTAL_BYTES) {
                batchError = t('web.skills.library.uploadTotalTooLarge')
                toApply = []
            }
        }

        if (toApply.length > 0) {
            const byPath = new Map(files.map((file) => [file.path, file]))
            const next = [...files]
            let firstKey: string | null = null
            let firstPath = ''
            for (const entry of toApply) {
                const existing = byPath.get(entry.path)
                if (existing) {
                    const index = next.findIndex(
                        (file) => file.key === existing.key
                    )
                    next[index] = { ...existing, content: entry.text }
                    if (!firstKey) {
                        firstKey = existing.key
                        firstPath = existing.path
                    }
                } else {
                    newFileSeq.current += 1
                    const key = `new-${newFileSeq.current}`
                    next.push({
                        key,
                        fileId: null,
                        path: entry.path,
                        content: entry.text
                    })
                    if (!firstKey) {
                        firstKey = key
                        firstPath = entry.path
                    }
                }
            }
            setFiles(next)
            if (firstKey) selectEntry(firstKey, firstPath)
        }

        const parts: string[] = []
        if (batchError) parts.push(batchError)
        if (rejectedLines.length > 0)
            parts.push(
                t('web.skills.library.uploadRejected', {
                    count: rejectedLines.length
                }),
                ...rejectedLines
            )
        setError(parts.length > 0 ? parts.join('\n') : null)
    }

    const renameValidate = (raw: string): string | null => {
        if (!renameTarget) return null
        if (renameTarget.kind === 'file') {
            return pathProblemMessage(raw, [
                SKILL_MD_KEY,
                ...files
                    .filter((file) => file.key !== renameTarget.key)
                    .map((file) => file.path)
            ])
        }
        const result = validateLibraryFilePath(raw)
        if (!result.valid)
            return t(
                result.code === 'reserved'
                    ? 'web.skills.library.pathReserved'
                    : 'web.skills.library.pathInvalid'
            )
        const prefix = `${renameTarget.path}/`
        const outside = [
            SKILL_MD_KEY,
            ...files
                .filter((file) => !file.path.startsWith(prefix))
                .map((file) => file.path)
        ]
        for (const file of files) {
            if (!file.path.startsWith(prefix)) continue
            const nextPath =
                result.value + file.path.slice(renameTarget.path.length)
            const problem = pathProblemMessage(nextPath, outside)
            if (problem) return problem
        }
        return null
    }

    const renameDraftFiles = (moves: Array<[string, string]>): void => {
        if (!detail || moves.length === 0) return
        const moveMap = new Map(moves)
        const serverPathById = new Map(
            detail.files.map((file) => [file.id, file.path])
        )
        setFiles((prev) =>
            prev.map((file) => {
                const nextPath = moveMap.get(file.key)
                if (!nextPath || nextPath === file.path) return file
                // A draft seeded from the server keeps its key = the server
                // file id; renaming back to that path restores the identity
                // instead of a delete + re-create round trip.
                if (serverPathById.get(file.key) === nextPath)
                    return { ...file, path: nextPath, fileId: file.key }
                return { ...file, path: nextPath, fileId: null }
            })
        )
        setDeletedIds((prev) => {
            let next = prev
            for (const [key, nextPath] of moves) {
                const serverPath = serverPathById.get(key)
                if (serverPath === undefined) continue
                if (serverPath === nextPath)
                    next = next.filter((id) => id !== key)
                else if (!next.includes(key)) next = [...next, key]
            }
            return next
        })
        const selectedMove = moves.find(([key]) => key === selected)
        if (
            selectedMove &&
            mode === 'preview' &&
            !selectedMove[1].toLowerCase().endsWith('.md')
        )
            setMode('edit')
    }

    const applyRename = (raw: string): void => {
        if (!renameTarget) return
        const result = validateLibraryFilePath(raw)
        if (!result.valid) return
        if (renameTarget.kind === 'file') {
            renameDraftFiles([[renameTarget.key, result.value]])
            return
        }
        const prefix = `${renameTarget.path}/`
        renameDraftFiles(
            files
                .filter((file) => file.path.startsWith(prefix))
                .map((file) => [
                    file.key,
                    result.value + file.path.slice(renameTarget.path.length)
                ])
        )
    }

    const treeActions: SkillTreeActions = {
        onActionError: (err) => setError(apiErrorMessage(err)),
        downloadEntry,
        newFileIn: newFileHere,
        uploadInto: requestUpload,
        renameEntry: (target) => {
            if (target.kind === 'file') {
                const file = files.find(
                    (candidate) => candidate.path === target.path
                )
                if (file)
                    setRenameTarget({
                        kind: 'file',
                        key: file.key,
                        path: file.path
                    })
                return
            }
            setRenameTarget({ kind: 'dir', path: target.path })
        },
        deleteFile: (path) => {
            const file = files.find((candidate) => candidate.path === path)
            if (file) removeFile(file)
        },
        deleteFolder: (dirPath) => {
            void removeFolder(dirPath)
        }
    }

    const discard = (): void => {
        if (!detail) return
        seed(detail)
        setSelected(SKILL_MD_KEY)
        setMode('edit')
        setError(null)
    }

    const startEditing = (): void => {
        setSelected(SKILL_MD_KEY)
        setMode('edit')
        setEditing(true)
    }

    const stopEditing = async (): Promise<void> => {
        if (dirty) {
            const confirmed = await confirm({
                title: t('web.skills.library.discardEditsTitle'),
                description: t('web.skills.library.discardEditsBody'),
                confirmLabel: t('web.skills.library.discard'),
                cancelLabel: t('common.cancel'),
                tone: 'danger'
            })
            if (!confirmed) return
            discard()
        }
        setSelected(SKILL_MD_KEY)
        setError(null)
        setEditing(false)
    }

    const leaveToLibrary = async (): Promise<void> => {
        if (dirty) {
            const confirmed = await confirm({
                title: t('web.skills.library.discardEditsTitle'),
                description: t('web.skills.library.discardEditsBody'),
                confirmLabel: t('web.skills.library.discard'),
                cancelLabel: t('common.cancel'),
                tone: 'danger'
            })
            if (!confirmed) return
        }
        navigate('/skills/library')
    }

    const save = async (): Promise<void> => {
        if (!detail || saving || !name.trim()) return
        setSaving(true)
        setError(null)
        try {
            const body: UpdateLibrarySkillBody = {}
            if (name !== detail.name) body.name = name.trim()
            if (description !== (detail.description ?? ''))
                body.description = description
            if (content !== detail.content) body.content = content
            if (Object.keys(body).length > 0)
                await client.skills.library.update(detail.id, body)
            // Delete before upserting: upsert is keyed by path, so removing
            // a file and re-adding one at the same path must not delete the
            // fresh row afterwards.
            for (const fileId of deletedIds) {
                await client.skills.library.deleteFile(detail.id, fileId)
                setDeletedIds((prev) => prev.filter((id) => id !== fileId))
            }
            for (const file of files) {
                const changed =
                    !file.fileId ||
                    serverFileById.get(file.fileId) !== file.content
                if (changed)
                    await client.skills.library.upsertFile(detail.id, {
                        path: file.path,
                        content: file.content
                    })
            }
            const next = await client.skills.library.get(detail.id)
            seed(next)
            setSelected(SKILL_MD_KEY)
            setSavedFlash(true)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setSaving(false)
        }
    }

    const exportSkill = async (): Promise<void> => {
        if (!detail || busy) return
        setBusy(true)
        setError(null)
        try {
            const { blob, filename } = await client.skills.library.export(
                detail.id
            )
            downloadBlob(blob, filename)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const pushSkill = async (): Promise<void> => {
        if (!detail || busy) return
        setBusy(true)
        setError(null)
        setPushNote(null)
        try {
            const { results } = await client.skills.library.push(detail.id)
            const ok = results.filter((item) => item.status === 'pushed').length
            const failed = results.length - ok
            setPushNote(
                failed === 0
                    ? t('web.skills.library.pushDone', { count: ok })
                    : t('web.skills.library.pushPartial', { ok, failed })
            )
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const removeSkill = async (): Promise<void> => {
        if (!detail || busy) return
        const confirmed = await confirm({
            title: t('web.skills.library.delete'),
            description: t('web.skills.library.deleteConfirm', {
                name: detail.name
            }),
            confirmLabel: t('web.skills.library.delete'),
            cancelLabel: t('common.cancel'),
            tone: 'danger'
        })
        if (!confirmed) return
        setBusy(true)
        setError(null)
        try {
            await client.skills.library.delete(detail.id)
            navigate('/skills/library')
        } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
                const forced = await confirm({
                    title: t('web.skills.library.delete'),
                    description: t('web.skills.library.deleteForceConfirm', {
                        count: installedCountFromError(
                            err,
                            detail.installedAgentCount
                        )
                    }),
                    confirmLabel: t('web.skills.library.delete'),
                    cancelLabel: t('common.cancel'),
                    tone: 'danger'
                })
                if (forced) {
                    try {
                        await client.skills.library.delete(detail.id, {
                            force: true
                        })
                        navigate('/skills/library')
                    } catch (err2) {
                        setError(apiErrorMessage(err2))
                    }
                }
            } else {
                setError(apiErrorMessage(err))
            }
        } finally {
            setBusy(false)
        }
    }

    return (
        <>
            <header className='mb-6 flex items-center justify-between gap-4'>
                {editing ? (
                    <button
                        type='button'
                        onClick={() => void leaveToLibrary()}
                        className='text-caption text-muted hover:text-fg inline-flex items-center gap-1.5 transition-colors'
                    >
                        <ArrowLeftIcon className='h-3.5 w-3.5' />
                        {t('web.skills.library.backToLibrary')}
                    </button>
                ) : (
                    <Link
                        to='/skills/library'
                        className='text-caption text-muted hover:text-fg inline-flex items-center gap-1.5 transition-colors'
                    >
                        <ArrowLeftIcon className='h-3.5 w-3.5' />
                        {t('web.skills.library.backToLibrary')}
                    </Link>
                )}
                {editing && detail && (
                    <div className='flex shrink-0 items-center gap-2'>
                        {dirty ? (
                            <span className='text-caption text-warning-strong inline-flex items-center gap-1.5'>
                                <span
                                    className='bg-warning-strong h-1.5 w-1.5 rounded-full'
                                    aria-hidden='true'
                                />
                                {t('web.skills.library.unsaved')}
                            </span>
                        ) : (
                            savedFlash && (
                                <span className='text-caption text-muted'>
                                    {t('web.skills.library.saved')}
                                </span>
                            )
                        )}
                        <button
                            type='button'
                            disabled={saving || !dirty || !name.trim()}
                            onClick={() => void save()}
                            className='workbench-button-primary'
                        >
                            {saving ? (
                                <>
                                    <Spinner size={16} className='mr-2' />
                                    {t('common.saving')}
                                </>
                            ) : (
                                t('web.skills.library.save')
                            )}
                        </button>
                        <button
                            type='button'
                            disabled={busy || saving}
                            onClick={() => void stopEditing()}
                            className='workbench-button-secondary'
                        >
                            {t('web.skills.library.doneEditing')}
                        </button>
                    </div>
                )}
            </header>

            {error && (
                <div className='workbench-alert-error mb-5 whitespace-pre-line'>
                    {error}
                </div>
            )}

            {loading && (
                <div aria-busy='true'>
                    <Ghost variant='title' className='w-48' />
                    <Ghost variant='cap' className='mt-3 w-72 max-w-full' />
                    <div className='workbench-panel mt-6 space-y-3 px-5 py-5'>
                        <Ghost variant='line' className='w-1/4' />
                        <Ghost variant='cap' className='w-3/5' />
                        <Ghost variant='cap' className='w-2/5' />
                    </div>
                </div>
            )}

            {!loading && !detail && !error && (
                <EmptyState
                    kind='no-results'
                    tier='stack'
                    title={t('web.customize.skillNotFoundTitle')}
                />
            )}

            {!loading && detail && editing && (
                <>
                    <div className='mb-6 flex items-start gap-4'>
                        <div className='bg-soft text-subtle shadow-ring-light mt-6 flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-sm'>
                            {userAvatar.imageUrl ? (
                                <img
                                    src={userAvatar.imageUrl}
                                    alt=''
                                    className='h-full w-full object-cover'
                                />
                            ) : (
                                <SkillsIcon className='h-6 w-6' />
                            )}
                        </div>
                        <div className='min-w-0 flex-1'>
                            <div className='flex flex-wrap gap-4'>
                                <div className='w-full sm:w-72'>
                                    <label
                                        htmlFor='library-skill-name'
                                        className='workbench-field-label'
                                    >
                                        {t('web.skills.library.nameLabel')}
                                    </label>
                                    <input
                                        id='library-skill-name'
                                        value={name}
                                        onChange={(event) =>
                                            setName(event.target.value)
                                        }
                                        disabled={saving}
                                        className='workbench-input font-medium'
                                    />
                                </div>
                                <div className='min-w-0 flex-1'>
                                    <label
                                        htmlFor='library-skill-description'
                                        className='workbench-field-label'
                                    >
                                        {t(
                                            'web.skills.library.descriptionLabel'
                                        )}
                                    </label>
                                    <input
                                        id='library-skill-description'
                                        value={description}
                                        onChange={(event) =>
                                            setDescription(event.target.value)
                                        }
                                        disabled={saving}
                                        placeholder={t(
                                            'web.skills.library.descriptionLabel'
                                        )}
                                        className='workbench-input'
                                    />
                                </div>
                            </div>
                            <div className='text-caption text-subtle mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5'>
                                <span className='inline-flex items-center gap-1.5'>
                                    <HistoryIcon className='h-3.5 w-3.5' />
                                    {t('web.skills.library.updatedOn', {
                                        date: formatDate(detail.updatedAt)
                                    })}
                                </span>
                                {detail.installedAgentCount > 0 && (
                                    <span className='inline-flex items-center gap-1.5'>
                                        <DownloadIcon className='h-3.5 w-3.5' />
                                        {t('web.skills.library.installedOn', {
                                            count: detail.installedAgentCount
                                        })}
                                    </span>
                                )}
                                {detail.origin && (
                                    <Tag>
                                        {t(
                                            ORIGIN_LABEL_KEY[detail.origin.type]
                                        )}
                                    </Tag>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className='grid h-[68dvh] min-h-[460px] gap-4 md:grid-cols-[260px_minmax(0,1fr)]'>
                        <aside className='settings-card flex min-h-0 flex-col p-2'>
                            <div className='text-caption text-subtle flex items-center justify-between px-2 pb-1.5 pt-1 font-medium'>
                                <span>{t('web.skills.library.files')}</span>
                                <button
                                    type='button'
                                    disabled={saving}
                                    onClick={() => requestUpload('')}
                                    aria-label={t(
                                        'web.skills.library.uploadFiles'
                                    )}
                                    title={t('web.skills.library.uploadFiles')}
                                    className='text-muted hover:text-fg rounded-pill flex h-6 w-6 shrink-0 items-center justify-center transition-colors'
                                >
                                    <UploadIcon className='h-3.5 w-3.5' />
                                </button>
                            </div>
                            <div className='min-h-0 flex-1 overflow-hidden'>
                                <SkillFileTree
                                    actions={treeActions}
                                    filePaths={files.map((file) => file.path)}
                                    selectedPath={selectedPath}
                                    onSelectPath={selectPath}
                                />
                            </div>
                            <div className='border-divider mt-2 border-t px-1 pb-1 pt-2'>
                                {addingFile ? (
                                    <div className='flex items-center gap-1.5'>
                                        <input
                                            ref={addPathInputRef}
                                            value={addPath}
                                            onChange={(event) =>
                                                setAddPath(event.target.value)
                                            }
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter') {
                                                    event.preventDefault()
                                                    addFile()
                                                } else if (
                                                    event.key === 'Escape'
                                                ) {
                                                    setAddPath('')
                                                    setAddingFile(false)
                                                    setError(null)
                                                }
                                            }}
                                            placeholder={t(
                                                'web.skills.library.addFilePlaceholder'
                                            )}
                                            spellCheck={false}
                                            className='workbench-input h-8 min-w-0 flex-1 px-2.5 font-mono'
                                        />
                                        <button
                                            type='button'
                                            disabled={!addPath.trim()}
                                            onClick={addFile}
                                            className='workbench-button-secondary h-8 shrink-0 px-2.5'
                                        >
                                            {t('web.skills.library.addFile')}
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        type='button'
                                        disabled={saving}
                                        onClick={() => {
                                            setAddingFile(true)
                                            window.setTimeout(
                                                () =>
                                                    addPathInputRef.current?.focus(),
                                                0
                                            )
                                        }}
                                        className='text-ui text-muted hover:text-fg hover:bg-soft flex w-full items-center gap-2 rounded-sm px-2 py-1.5 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50'
                                    >
                                        <PlusIcon className='h-3.5 w-3.5' />
                                        {t('web.skills.library.newFile')}
                                    </button>
                                )}
                            </div>
                        </aside>

                        <section className='settings-card flex min-h-0 flex-col'>
                            <div className='border-divider/60 flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5'>
                                <div className='flex min-w-0 items-center gap-1.5'>
                                    <span className='text-ui text-fg truncate font-mono'>
                                        {selectedPath}
                                    </span>
                                    {selectedFile && (
                                        <button
                                            type='button'
                                            onClick={() =>
                                                removeFile(selectedFile)
                                            }
                                            aria-label={t(
                                                'web.skills.library.delete'
                                            )}
                                            className='text-muted hover:text-error rounded-pill flex h-7 w-7 shrink-0 items-center justify-center transition-colors'
                                        >
                                            <TrashIcon className='h-3.5 w-3.5' />
                                        </button>
                                    )}
                                </div>
                                {isMarkdown && (
                                    <div className='bg-soft shadow-ring-light inline-flex gap-1 rounded-md p-1'>
                                        <button
                                            type='button'
                                            onClick={() => setMode('edit')}
                                            className={modeTabClass(
                                                mode === 'edit'
                                            )}
                                        >
                                            {t('web.skills.library.editTab')}
                                        </button>
                                        <button
                                            type='button'
                                            onClick={() => setMode('preview')}
                                            className={modeTabClass(
                                                mode === 'preview'
                                            )}
                                        >
                                            {t('web.skills.library.preview')}
                                        </button>
                                    </div>
                                )}
                            </div>
                            {mode === 'preview' && isMarkdown ? (
                                <div className='min-h-0 flex-1 overflow-y-auto px-5 py-4'>
                                    <MarkdownText
                                        text={stripFrontmatter(selectedContent)}
                                        variant='doc'
                                    />
                                </div>
                            ) : (
                                <textarea
                                    value={selectedContent}
                                    onChange={(event) =>
                                        updateSelectedContent(
                                            event.target.value
                                        )
                                    }
                                    spellCheck={false}
                                    disabled={saving}
                                    className='text-ui text-fg focus-visible:shadow-focus-inset min-h-0 w-full flex-1 resize-none bg-transparent px-4 py-3 font-mono transition-shadow focus:outline-none'
                                />
                            )}
                        </section>
                    </div>

                    <input
                        ref={uploadInputRef}
                        type='file'
                        multiple
                        className='hidden'
                        onChange={() => {
                            void handleUploadFiles()
                        }}
                    />

                    {renameTarget && (
                        <SkillPathDialog
                            title={t('web.skills.library.renameTitle', {
                                name: baseName(renameTarget.path)
                            })}
                            initialPath={renameTarget.path}
                            validate={renameValidate}
                            onSubmit={applyRename}
                            onClose={() => setRenameTarget(null)}
                        />
                    )}
                </>
            )}

            {!loading && detail && !editing && (
                <>
                    <div className='mb-6 flex items-start gap-4'>
                        <div className='bg-soft text-subtle shadow-ring-light flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-sm'>
                            {userAvatar.imageUrl ? (
                                <img
                                    src={userAvatar.imageUrl}
                                    alt=''
                                    className='h-full w-full object-cover'
                                />
                            ) : (
                                <SkillsIcon className='h-6 w-6' />
                            )}
                        </div>
                        <div className='min-w-0 flex-1'>
                            <h1 className='text-h1 text-fg'>{detail.name}</h1>
                            {detail.description && (
                                <p className='text-body text-muted mt-1.5 max-w-[68ch] text-pretty'>
                                    {detail.description}
                                </p>
                            )}
                            <div className='text-caption text-subtle mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5'>
                                <span className='inline-flex items-center gap-1.5'>
                                    <HistoryIcon className='h-3.5 w-3.5' />
                                    {t('web.skills.library.updatedOn', {
                                        date: formatDate(detail.updatedAt)
                                    })}
                                </span>
                                {detail.installedAgentCount > 0 && (
                                    <span className='inline-flex items-center gap-1.5'>
                                        <DownloadIcon className='h-3.5 w-3.5' />
                                        {t('web.skills.library.installedOn', {
                                            count: detail.installedAgentCount
                                        })}
                                    </span>
                                )}
                                {detail.origin && (
                                    <Tag>
                                        {t(
                                            ORIGIN_LABEL_KEY[detail.origin.type]
                                        )}
                                    </Tag>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className='grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]'>
                        <main className='settings-card p-6 sm:p-8'>
                            <div className='border-divider/60 mb-6 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-b pb-3'>
                                {viewDocs.map((doc) => {
                                    const active = doc.key === selected
                                    if (viewDocs.length === 1)
                                        return (
                                            <span
                                                key={doc.key}
                                                className='text-ui text-fg font-medium'
                                            >
                                                {baseName(doc.path)}
                                            </span>
                                        )
                                    return (
                                        <button
                                            key={doc.key}
                                            type='button'
                                            aria-current={
                                                active ? 'true' : undefined
                                            }
                                            onClick={() => setSelected(doc.key)}
                                            className={
                                                active
                                                    ? 'text-ui text-fg font-medium'
                                                    : 'text-ui text-muted hover:text-fg font-normal transition-colors'
                                            }
                                        >
                                            {baseName(doc.path)}
                                        </button>
                                    )
                                })}
                            </div>
                            {viewBody.trim() ? (
                                isMarkdown ? (
                                    <div className='max-w-[72ch]'>
                                        <MarkdownText
                                            text={viewBody}
                                            variant='doc'
                                        />
                                    </div>
                                ) : (
                                    <pre className='bg-soft text-ui text-fg overflow-x-auto whitespace-pre rounded-sm p-4 font-mono'>
                                        {selectedContent}
                                    </pre>
                                )
                            ) : (
                                <EmptyState
                                    kind='no-results'
                                    tier='line'
                                    title={t('web.customize.readmeMissing')}
                                />
                            )}
                        </main>

                        <aside className='flex flex-col gap-4 lg:sticky lg:top-6'>
                            <div className='settings-card p-4'>
                                <button
                                    type='button'
                                    onClick={() => setInstallOpen(true)}
                                    className='workbench-button-primary w-full justify-center gap-1.5'
                                >
                                    <DownloadIcon className='h-4 w-4' />
                                    {t('web.customize.installToAgent')}
                                </button>
                                <button
                                    type='button'
                                    onClick={startEditing}
                                    className='workbench-button-secondary mt-2 w-full justify-center gap-1.5'
                                >
                                    <EditIcon className='h-4 w-4' />
                                    {t('web.skills.library.edit')}
                                </button>
                                <div className='border-divider/60 mt-3 flex flex-wrap items-center gap-1 border-t pt-3'>
                                    <button
                                        type='button'
                                        disabled={busy}
                                        onClick={() => setShareOpen(true)}
                                        className={`${CARD_GHOST_BASE} text-muted hover:bg-surface-hover`}
                                    >
                                        <ShareIcon className='h-3.5 w-3.5' />
                                        {t('web.skills.library.share')}
                                    </button>
                                    <button
                                        type='button'
                                        disabled={busy}
                                        onClick={() => void exportSkill()}
                                        className={`${CARD_GHOST_BASE} text-muted hover:bg-surface-hover`}
                                    >
                                        <FileExportIcon className='h-3.5 w-3.5' />
                                        {t('web.skills.library.export')}
                                    </button>
                                    {detail.installedAgentCount > 0 && (
                                        <button
                                            type='button'
                                            disabled={busy}
                                            onClick={() => void pushSkill()}
                                            className={`${CARD_GHOST_BASE} text-muted hover:bg-surface-hover`}
                                        >
                                            <UploadIcon className='h-3.5 w-3.5' />
                                            {t('web.skills.library.pushAction')}
                                        </button>
                                    )}
                                    <button
                                        type='button'
                                        disabled={busy}
                                        onClick={() => void removeSkill()}
                                        className={`${CARD_GHOST_BASE} text-workflow-ship hover:bg-danger-hover ml-auto`}
                                    >
                                        <TrashIcon className='h-3.5 w-3.5' />
                                        {t('web.skills.library.delete')}
                                    </button>
                                </div>
                                {pushNote && (
                                    <p className='text-caption text-muted mt-3'>
                                        {pushNote}
                                    </p>
                                )}
                            </div>

                            <div className='settings-card p-4'>
                                <div className='settings-card-label mb-2.5'>
                                    {t('web.customize.infoTitle')}
                                </div>
                                <dl className='flex flex-col'>
                                    {detail.origin && (
                                        <MetaRow
                                            label={t(
                                                'web.skills.library.metaOrigin'
                                            )}
                                            value={t(
                                                ORIGIN_LABEL_KEY[
                                                    detail.origin.type
                                                ]
                                            )}
                                        />
                                    )}
                                    {detail.fileCount > 0 && (
                                        <MetaRow
                                            label={t(
                                                'web.skills.library.files'
                                            )}
                                            value={String(detail.fileCount)}
                                            mono
                                        />
                                    )}
                                    <MetaRow
                                        label={t(
                                            'web.skills.library.metaCreated'
                                        )}
                                        value={formatDate(detail.createdAt)}
                                    />
                                </dl>
                            </div>
                        </aside>
                    </div>
                </>
            )}

            {detail && installOpen && (
                <LibraryInstallDialog
                    skillId={detail.id}
                    name={detail.name}
                    onClose={() => setInstallOpen(false)}
                />
            )}

            {detail && shareOpen && (
                <ShareSkillDialog
                    skillId={detail.id}
                    name={detail.name}
                    onClose={() => setShareOpen(false)}
                />
            )}

            {confirmDialog}
        </>
    )
}

const MetaRow: FC<{
    label: string
    value: string | null
    mono?: boolean
}> = ({ label, value, mono }) => {
    if (!value) return null
    return (
        <div className='border-divider/60 flex items-baseline justify-between gap-3 border-t py-1.5 first:border-t-0 first:pt-0'>
            <dt className='text-caption text-muted shrink-0'>{label}</dt>
            <dd
                className={`text-fg min-w-0 text-right font-medium ${mono ? 'text-caption font-mono font-normal' : 'text-ui'}`}
            >
                {value}
            </dd>
        </div>
    )
}

export default LibrarySkillEditor
