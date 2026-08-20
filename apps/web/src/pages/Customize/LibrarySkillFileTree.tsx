import type { CSSProperties, FC, ReactNode } from 'react'
import { useEffect, useMemo, useRef } from 'react'
import type { ContextMenuItem, ContextMenuOpenContext } from '@pierre/trees'
import {
    FileTree,
    useFileTree,
    useFileTreeSelection
} from '@pierre/trees/react'
import { FILE_TREE_THEME } from '@/components/files/fileTreeTheme'
import {
    copyTextToClipboard,
    TreeContextMenuPanel,
    TreeMenuItem
} from '@/components/files/treeMenu'
import {
    CopyIcon,
    DownloadIcon,
    EditIcon,
    FilePlusIcon,
    TrashIcon,
    UploadIcon
} from '@/components/icons'
import { useI18n } from '@/lib/i18n'
import { baseName } from './librarySkillFileUtils'

export const SKILL_MD_KEY = 'SKILL.md'

export interface SkillTreeActions {
    onActionError: (err: unknown) => void
    downloadEntry: (path: string) => void
    newFileIn: (dirPath: string) => void
    uploadInto: (dirPath: string) => void
    renameEntry: (target: { kind: 'file' | 'dir'; path: string }) => void
    deleteFile: (path: string) => void
    deleteFolder: (dirPath: string) => void
}

const normalizeTreeItemPath = (path: string): string =>
    path.replace(/^\/+|\/+$/g, '')

const SkillTreeMenu: FC<{
    actions: SkillTreeActions
    item: ContextMenuItem
    menuContext: ContextMenuOpenContext
}> = ({ actions, item, menuContext }): ReactNode => {
    const { t } = useI18n()
    const relPath = normalizeTreeItemPath(item.path)
    const name = baseName(relPath)
    const isDir = item.kind === 'directory'
    const isSkillMd = !isDir && relPath === SKILL_MD_KEY
    const run = (action: () => void | Promise<void>): void => {
        menuContext.close()
        void Promise.resolve(action()).catch(actions.onActionError)
    }

    return (
        <TreeContextMenuPanel
            anchorRect={menuContext.anchorRect}
            title={name}
        >
            <TreeMenuItem
                icon={<CopyIcon className='h-4 w-4' />}
                label={t('web.workspaceFiles.copyPath')}
                onClick={() => run(() => copyTextToClipboard(relPath))}
            />
            <TreeMenuItem
                icon={<CopyIcon className='h-4 w-4' />}
                label={t('web.workspaceFiles.copyFilename')}
                onClick={() => run(() => copyTextToClipboard(name))}
            />
            {!isDir && (
                <>
                    <div className='popover-separator' />
                    <TreeMenuItem
                        icon={<DownloadIcon className='h-4 w-4' />}
                        label={t('web.workspaceFiles.downloadFile')}
                        onClick={() => run(() => actions.downloadEntry(relPath))}
                    />
                </>
            )}
            {isDir && (
                <>
                    <div className='popover-separator' />
                    <TreeMenuItem
                        icon={<FilePlusIcon className='h-4 w-4' />}
                        label={t('web.skills.library.newFileHere')}
                        onClick={() => run(() => actions.newFileIn(relPath))}
                    />
                    <TreeMenuItem
                        icon={<UploadIcon className='h-4 w-4' />}
                        label={t('web.skills.library.uploadFiles')}
                        onClick={() => run(() => actions.uploadInto(relPath))}
                    />
                </>
            )}
            {!isSkillMd && (
                <>
                    <div className='popover-separator' />
                    <TreeMenuItem
                        icon={<EditIcon className='h-4 w-4' />}
                        label={t(
                            isDir
                                ? 'web.skills.library.renameFolder'
                                : 'web.skills.library.rename'
                        )}
                        onClick={() =>
                            run(() =>
                                actions.renameEntry({
                                    kind: isDir ? 'dir' : 'file',
                                    path: relPath
                                })
                            )
                        }
                    />
                    <TreeMenuItem
                        tone='danger'
                        icon={<TrashIcon className='h-4 w-4' />}
                        label={t(
                            isDir
                                ? 'web.skills.library.deleteFolder'
                                : 'web.skills.library.delete'
                        )}
                        onClick={() =>
                            run(() =>
                                isDir
                                    ? actions.deleteFolder(relPath)
                                    : actions.deleteFile(relPath)
                            )
                        }
                    />
                </>
            )}
        </TreeContextMenuPanel>
    )
}

interface SkillFileTreeProps {
    actions: SkillTreeActions
    filePaths: string[]
    selectedPath: string
    onSelectPath: (path: string) => void
}

const SkillFileTree: FC<SkillFileTreeProps> = ({
    actions,
    filePaths,
    selectedPath,
    onSelectPath
}): ReactNode => {
    const onSelectPathRef = useRef(onSelectPath)
    const filePathsRef = useRef<Set<string>>(new Set([SKILL_MD_KEY]))
    const pathSignature = filePaths.join('\u0000')
    const paths = useMemo(
        () => [
            SKILL_MD_KEY,
            ...(pathSignature ? pathSignature.split('\u0000') : [])
        ],
        [pathSignature]
    )
    const { model } = useFileTree({
        composition: {
            contextMenu: {
                buttonVisibility: 'when-needed',
                triggerMode: 'both'
            }
        },
        flattenEmptyDirectories: true,
        icons: { colored: true, set: 'complete' },
        initialExpansion: 'open',
        itemHeight: 30,
        paths: [],
        search: true
    })
    const selectedPaths = useFileTreeSelection(model)

    useEffect(() => {
        onSelectPathRef.current = onSelectPath
    }, [onSelectPath])

    useEffect(() => {
        const path = selectedPaths.at(-1)
        if (path && filePathsRef.current.has(path)) {
            onSelectPathRef.current(path)
        }
    }, [selectedPaths])

    useEffect(() => {
        filePathsRef.current = new Set(paths)
        model.resetPaths(paths)
    }, [model, paths])

    useEffect(() => {
        for (const path of model.getSelectedPaths()) {
            if (path !== selectedPath) model.getItem(path)?.deselect()
        }
        const selectedItem = model.getItem(selectedPath)
        if (selectedItem && !selectedItem.isSelected()) selectedItem.select()
    }, [model, paths, selectedPath])

    return (
        <FileTree
            id='library-skill-files'
            model={model}
            renderContextMenu={(item, menuContext) => (
                <SkillTreeMenu
                    actions={actions}
                    item={item}
                    menuContext={menuContext}
                />
            )}
            style={
                {
                    ...FILE_TREE_THEME,
                    // This tree sits inside a settings-card (surface), not on
                    // the chat canvas: the tree bg must match its host panel
                    // because @pierre/trees paints it on sticky overlays and
                    // truncate fade masks, which need an opaque matching fill.
                    '--trees-bg-override': 'rgb(var(--color-surface))'
                } as CSSProperties
            }
        />
    )
}

export default SkillFileTree
