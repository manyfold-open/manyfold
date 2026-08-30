import {
    AgentFramework,
    AgentModelConfig,
    AgentModelConfigSource,
    AgentModelConfigView,
    AgentRuntime,
    AgentStatus,
    CHAT_ATTACHMENT_ACCEPT,
    CHAT_ATTACHMENT_MAX_COUNT,
    CHAT_ATTACHMENT_MAX_FILE_BYTES,
    CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
    ClaudeCodePermissionMode,
    HermesPermissionMode,
    CodexIntelligence,
    CodexPermissionMode,
    CodexSpeed,
    CreateMessageContextRefInput,
    DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
    DEFAULT_HERMES_PERMISSION_MODE,
    DEFAULT_CODEX_PERMISSION_MODE,
    claudeCodeModelAliasMapKey,
    claudeCodeEfforts,
    codexCanonicalModelId,
    codexIntelligenceLevels,
    codexSpeeds,
    isAllowedChatAttachment,
    isClaudeCodeModelAlias,
    isClaudeCodeOneMillionModelAlias,
    resolveClaudeCodeModelOptions
} from '@manyfold/shared'
import type {
    ClipboardEvent,
    FC,
    KeyboardEvent,
    ReactNode,
    RefObject
} from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
    ArrowUpIcon,
    CheckIcon,
    ChevronDownIcon,
    ChevronRightIcon,
    CloseIcon,
    CodeIcon,
    EditIcon,
    FileIcon,
    FileArchiveIcon,
    FileSpreadsheetIcon,
    FileTextIcon,
    FolderIcon,
    HandIcon,
    InfoIcon,
    type LucideIcon,
    PaperclipIcon,
    PlusIcon,
    RefreshIcon,
    SettingsIcon,
    ShieldAlertIcon,
    ShieldCheckIcon,
    StopIcon,
    TasksIcon,
    ZapIcon
} from '@/components/icons'
import { Spinner } from '@/components/Loading'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import ComposerMenu from '@/components/chat/ComposerMenu'
import ModelSourceSwitch from '@/components/chat/ModelSourceSwitch'
import {
    claudeEffortOptionsForDraft,
    codexIntelligenceOptionsForModel,
    codexSpeedOptions,
    formatCodexIntelligenceLabel,
    formatCodexSpeedLabel,
    formatClaudeEffortLabel,
    modelConfigDisplayLabel,
    normalizeClaudeModelConfigDraft,
    patchRuntimeLocalDraft,
    runtimeLocalModelOptions,
    validateModelConfigDraft,
    withClaudeEffort,
    withClaudeModel,
    withCodexIntelligence,
    withCodexModel,
    withCodexSpeed,
    withGeminiModel
} from '@/lib/agentModelConfig'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import { agentSettingsPath } from '@/lib/agentSettingsPath'
import { formatDateTime } from '@/lib/dateFormat'
import { FrameworkLogo } from '@/lib/frameworkMeta'
import { useI18n, type TFn } from '@/lib/i18n'

interface Props {
    disabled: boolean
    streaming: boolean
    onSend: (
        text: string,
        attachments: ComposerSendAttachment[],
        contextRefs: ComposerContextRef[],
        helpers: ComposerSendHelpers
    ) => Promise<void> | void
    onStop?: () => void
    hint?: string
    agentName?: string
    framework?: AgentFramework
    runtime?: AgentRuntime
    status?: AgentStatus
    model?: string | null
    modelOverride?: string | null
    modelOptions?: string[]
    modelPickerDisabled?: boolean
    onModelOverrideChange?: (model: string | null) => void
    modelConfigView?: AgentModelConfigView | null
    modelConfigDraft?: AgentModelConfig | null
    modelConfigSource?: AgentModelConfigSource
    modelConfigRefreshing?: boolean
    claudeCodePermissionMode?: ClaudeCodePermissionMode
    onClaudeCodePermissionModeChange?: (mode: ClaudeCodePermissionMode) => void
    codexPermissionMode?: CodexPermissionMode
    onCodexPermissionModeChange?: (mode: CodexPermissionMode) => void
    hermesPermissionMode?: HermesPermissionMode
    onHermesPermissionModeChange?: (mode: HermesPermissionMode) => void
    onModelConfigDraftChange?: (config: AgentModelConfig) => void
    onModelConfigSourceChange?: (source: AgentModelConfigSource) => void
    onRefreshModelConfig?: (
        source?: AgentModelConfigSource
    ) => Promise<void> | void
    onOpenModelSettings?: () => void
    variant?: 'dock' | 'inline'
    showAgentSwitcher?: boolean
    agentOptions?: ComposerAgentOption[]
    selectedAgentId?: string | null
    onSelectAgent?: (agentId: string) => void
    attachmentsEnabled?: boolean
    contextRefs?: ComposerContextRef[]
    draftKey?: string | null
    onRemoveContextRef?: (id: string) => void
    dropTargetRef?: RefObject<HTMLElement | null>
    // Fired when the user shows intent to send (composer focus); AgentChat
    // uses it to prewarm the sprite so VM resume overlaps typing time.
    onComposeIntent?: () => void
}

export interface ComposerAgentOption {
    id: string
    name: string
    framework?: AgentFramework
    status?: AgentStatus
    disabled?: boolean
    disabledReason?: string
}

export interface ComposerSendAttachment {
    id: string
    file: File
}

export interface ComposerContextRef extends CreateMessageContextRefInput {
    id: string
    path: string
    rootId: string
    name: string
    entryType: 'file' | 'dir'
}

export interface ComposerSendHelpers {
    setAttachmentProgress: (id: string, progress: number) => void
    setAttachmentUploaded: (id: string, path: string) => void
    setAttachmentError: (id: string, error: string) => void
}

interface PendingAttachment {
    id: string
    file: File
    previewUrl: string | null
    progress: number
    status: 'pending' | 'uploading' | 'uploaded' | 'error'
    path?: string
    error?: string
}

type ComposerPermissionMode =
    | ClaudeCodePermissionMode
    | CodexPermissionMode
    | HermesPermissionMode

interface ComposerPermissionOption<T extends ComposerPermissionMode> {
    value: T
    labelKey: string
    titleKey: string
    descriptionKey: string
    icon: LucideIcon
    dangerous?: boolean
}

const claudeCodePermissionOptions: Array<
    ComposerPermissionOption<ClaudeCodePermissionMode>
> = [
    {
        value: 'default',
        labelKey: 'web.composer.permission.claude.ask',
        titleKey: 'web.composer.permission.claude.askTitle',
        descriptionKey: 'web.composer.permission.claude.askDescription',
        icon: HandIcon
    },
    {
        value: 'acceptEdits',
        labelKey: 'web.composer.permission.claude.acceptEdits',
        titleKey: 'web.composer.permission.claude.acceptEditsTitle',
        descriptionKey: 'web.composer.permission.claude.acceptEditsDescription',
        icon: EditIcon
    },
    {
        value: 'plan',
        labelKey: 'web.composer.permission.claude.plan',
        titleKey: 'web.composer.permission.claude.planTitle',
        descriptionKey: 'web.composer.permission.claude.planDescription',
        icon: TasksIcon
    },
    {
        value: 'auto',
        labelKey: 'web.composer.permission.claude.auto',
        titleKey: 'web.composer.permission.claude.autoTitle',
        descriptionKey: 'web.composer.permission.claude.autoDescription',
        icon: ZapIcon
    },
    {
        value: 'dontAsk',
        labelKey: 'web.composer.permission.claude.dontAsk',
        titleKey: 'web.composer.permission.claude.dontAskTitle',
        descriptionKey: 'web.composer.permission.claude.dontAskDescription',
        icon: ShieldCheckIcon
    },
    {
        value: 'bypassPermissions',
        labelKey: 'web.composer.permission.claude.bypass',
        titleKey: 'web.composer.permission.claude.bypassTitle',
        descriptionKey: 'web.composer.permission.claude.bypassDescription',
        icon: ShieldAlertIcon,
        dangerous: true
    }
]

const codexPermissionOptions: Array<
    ComposerPermissionOption<CodexPermissionMode>
> = [
    {
        value: 'default',
        labelKey: 'web.composer.permission.codex.ask',
        titleKey: 'web.composer.permission.codex.askTitle',
        descriptionKey: 'web.composer.permission.codex.askDescription',
        icon: HandIcon
    },
    {
        value: 'auto-review',
        labelKey: 'web.composer.permission.codex.approve',
        titleKey: 'web.composer.permission.codex.approveTitle',
        descriptionKey: 'web.composer.permission.codex.approveDescription',
        icon: ShieldCheckIcon
    },
    {
        value: 'full-access',
        labelKey: 'web.composer.permission.codex.full',
        titleKey: 'web.composer.permission.codex.fullTitle',
        descriptionKey: 'web.composer.permission.codex.fullDescription',
        icon: ShieldAlertIcon,
        dangerous: true
    }
]

const hermesPermissionOptions: Array<
    ComposerPermissionOption<HermesPermissionMode>
> = [
    {
        value: 'default',
        labelKey: 'web.composer.permission.hermes.ask',
        titleKey: 'web.composer.permission.hermes.askTitle',
        descriptionKey: 'web.composer.permission.hermes.askDescription',
        icon: HandIcon
    },
    {
        value: 'acceptEdits',
        labelKey: 'web.composer.permission.hermes.acceptEdits',
        titleKey: 'web.composer.permission.hermes.acceptEditsTitle',
        descriptionKey: 'web.composer.permission.hermes.acceptEditsDescription',
        icon: EditIcon
    },
    {
        value: 'dontAsk',
        labelKey: 'web.composer.permission.hermes.dontAsk',
        titleKey: 'web.composer.permission.hermes.dontAskTitle',
        descriptionKey: 'web.composer.permission.hermes.dontAskDescription',
        icon: ShieldAlertIcon,
        dangerous: true
    }
]

// Mirrors the CSS clamp (.chat-composer-input max-height: 240px).
const resizeComposerInput = (node: HTMLTextAreaElement): void => {
    node.style.height = 'auto'
    const maxHeight = 240
    node.style.height = `${Math.min(node.scrollHeight, maxHeight)}px`
}

const Composer: FC<Props> = ({
    disabled,
    streaming,
    onSend,
    onStop,
    hint,
    agentName,
    framework,
    model,
    modelOverride,
    modelOptions = [],
    modelPickerDisabled = false,
    onModelOverrideChange,
    modelConfigView = null,
    modelConfigDraft = null,
    modelConfigSource,
    modelConfigRefreshing = false,
    claudeCodePermissionMode = DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
    onClaudeCodePermissionModeChange,
    codexPermissionMode = DEFAULT_CODEX_PERMISSION_MODE,
    onCodexPermissionModeChange,
    hermesPermissionMode = DEFAULT_HERMES_PERMISSION_MODE,
    onHermesPermissionModeChange,
    onModelConfigDraftChange,
    onModelConfigSourceChange,
    onRefreshModelConfig,
    onOpenModelSettings,
    variant = 'dock',
    showAgentSwitcher = false,
    agentOptions = [],
    selectedAgentId,
    onSelectAgent,
    attachmentsEnabled = true,
    contextRefs = [],
    draftKey = null,
    onRemoveContextRef,
    dropTargetRef,
    onComposeIntent
}): ReactNode => {
    const { t } = useI18n()
    const { confirm, confirmDialog } = useProductConfirm()
    const [text, setText] = useState(() => readDraft(draftKey))
    const [attachments, setAttachments] = useState<PendingAttachment[]>([])
    const [attachmentError, setAttachmentError] = useState<string | null>(null)
    const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false)
    const [isDragActive, setIsDragActive] = useState(false)
    const dragDepthRef = useRef(0)
    const [agentMenuOpen, setAgentMenuOpen] = useState(false)
    const [modelMenuOpen, setModelMenuOpen] = useState(false)
    const [modelFilter, setModelFilter] = useState('')
    const [permissionMenuOpen, setPermissionMenuOpen] = useState(false)
    const textareaRef = useRef<HTMLTextAreaElement | null>(null)
    const fileInputRef = useRef<HTMLInputElement | null>(null)
    const attachmentsRef = useRef<PendingAttachment[]>([])
    const attachmentMenuRef = useRef<HTMLDivElement | null>(null)
    const agentSwitcherRef = useRef<HTMLDivElement | null>(null)
    const modelMenuRef = useRef<HTMLDivElement | null>(null)
    const permissionMenuRef = useRef<HTMLDivElement | null>(null)
    const agentMenuPanelRef = useRef<HTMLDivElement | null>(null)
    const attachmentMenuPanelRef = useRef<HTMLDivElement | null>(null)
    const modelMenuPanelRef = useRef<HTMLDivElement | null>(null)
    const permissionMenuPanelRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
        attachmentsRef.current = attachments
    }, [attachments])

    useEffect(
        () => () => {
            revokeAttachmentUrls(attachmentsRef.current)
        },
        []
    )

    useEffect(() => {
        setText(readDraft(draftKey))
        setAttachmentError(null)
        setAttachments((prev) => {
            revokeAttachmentUrls(prev)
            return []
        })
    }, [draftKey])

    useEffect(() => {
        if (!draftKey) return
        if (!text) {
            clearDraft(draftKey)
            return
        }
        const handle = window.setTimeout(() => {
            writeDraft(draftKey, text)
        }, 200)
        return () => {
            window.clearTimeout(handle)
            writeDraft(draftKey, text)
        }
    }, [draftKey, text])

    useEffect(() => {
        const node = textareaRef.current
        if (node) resizeComposerInput(node)
    }, [text])

    useEffect(() => {
        const onWindowResize = (): void => {
            const node = textareaRef.current
            if (node) resizeComposerInput(node)
        }
        window.addEventListener('resize', onWindowResize)
        return () => window.removeEventListener('resize', onWindowResize)
    }, [])

    useEffect(() => {
        if (
            !agentMenuOpen &&
            !attachmentMenuOpen &&
            !modelMenuOpen &&
            !permissionMenuOpen
        )
            return

        const handlePointerDown = (event: MouseEvent): void => {
            const target = event.target as Node
            /* The composer menus are portaled to <body>, so a click inside one
               is not inside its trigger — both refs have to be checked or
               selecting an option would close the menu as an outside click. */
            const nodes = [
                agentSwitcherRef.current,
                attachmentMenuRef.current,
                modelMenuRef.current,
                permissionMenuRef.current,
                agentMenuPanelRef.current,
                attachmentMenuPanelRef.current,
                modelMenuPanelRef.current,
                permissionMenuPanelRef.current
            ]
            if (nodes.some((node) => node?.contains(target))) return
            setAgentMenuOpen(false)
            setAttachmentMenuOpen(false)
            setModelMenuOpen(false)
            setPermissionMenuOpen(false)
        }
        const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
            if (event.key === 'Escape') {
                setAgentMenuOpen(false)
                setAttachmentMenuOpen(false)
                setModelMenuOpen(false)
                setPermissionMenuOpen(false)
            }
        }

        document.addEventListener('mousedown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)
        return () => {
            document.removeEventListener('mousedown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [agentMenuOpen, attachmentMenuOpen, modelMenuOpen, permissionMenuOpen])

    const setAttachmentProgress = (id: string, progress: number): void => {
        setAttachments((prev) =>
            prev.map((attachment) =>
                attachment.id === id
                    ? {
                          ...attachment,
                          progress,
                          status: 'uploading',
                          error: undefined
                      }
                    : attachment
            )
        )
    }

    const setAttachmentUploaded = (id: string, path: string): void => {
        setAttachments((prev) =>
            prev.map((attachment) =>
                attachment.id === id
                    ? {
                          ...attachment,
                          progress: 1,
                          status: 'uploaded',
                          path,
                          error: undefined
                      }
                    : attachment
            )
        )
    }

    const setAttachmentUploadError = (id: string, error: string): void => {
        setAttachments((prev) =>
            prev.map((attachment) =>
                attachment.id === id
                    ? { ...attachment, status: 'error', error }
                    : attachment
            )
        )
    }

    const submit = async (): Promise<void> => {
        const draft = text
        const value = draft.trim()
        const sendableAttachments = attachments.filter(
            (attachment) => attachment.status !== 'error'
        )
        if (
            (!value &&
                sendableAttachments.length === 0 &&
                contextRefs.length === 0) ||
            disabled ||
            streaming ||
            attachments.some((attachment) => attachment.status === 'error')
        )
            return
        /* Drop the text before awaiting the send, never after: `onSend`
           re-renders the chat around this composer, and anything that remounts
           it mid-send re-seeds the textarea from the stored draft — the message
           just sent would reappear in the input. Failures hand the draft back. */
        setText('')
        clearDraft(draftKey)
        setAttachmentError(null)
        setPermissionMenuOpen(false)
        try {
            await onSend(
                value,
                sendableAttachments.map((attachment) => ({
                    id: attachment.id,
                    file: attachment.file
                })),
                contextRefs,
                {
                    setAttachmentProgress,
                    setAttachmentUploaded,
                    setAttachmentError: setAttachmentUploadError
                }
            )
            setAttachments((prev) => {
                revokeAttachmentUrls(prev)
                return []
            })
        } catch {
            /* parent owns the visible error; keep the draft recoverable */
            setText(draft)
            writeDraft(draftKey, draft)
        }
    }

    const openAttachmentPicker = (): void => {
        if (disabled || streaming || !attachmentsEnabled) return
        setAttachmentMenuOpen(false)
        fileInputRef.current?.click()
    }

    const toggleAttachmentMenu = (): void => {
        if (attachmentButtonDisabled) return
        setAgentMenuOpen(false)
        setModelMenuOpen(false)
        setPermissionMenuOpen(false)
        setAttachmentMenuOpen((prev) => !prev)
    }

    const toggleModelMenu = (): void => {
        if (modelButtonDisabled) return
        setAgentMenuOpen(false)
        setAttachmentMenuOpen(false)
        setPermissionMenuOpen(false)
        setModelFilter('')
        setModelMenuOpen((prev) => !prev)
    }

    const togglePermissionMenu = (): void => {
        if (permissionButtonDisabled) return
        setAgentMenuOpen(false)
        setAttachmentMenuOpen(false)
        setModelMenuOpen(false)
        setPermissionMenuOpen((prev) => !prev)
    }

    const selectPermissionMode = async (
        mode: ComposerPermissionMode
    ): Promise<void> => {
        const option = permissionOptions.find((item) => item.value === mode)
        setPermissionMenuOpen(false)
        if (option?.dangerous && mode !== activePermissionMode) {
            const confirmed = await confirm({
                title: t('web.composer.dangerousPermissionTitle', {
                    mode: option.label
                }),
                description: t('web.composer.dangerousPermissionDescription', {
                    framework: frameworkLabel
                }),
                confirmLabel: t('web.composer.dangerousPermissionConfirm'),
                tone: 'danger'
            })
            if (!confirmed) return
        }
        if (canChooseClaudeCodePermissions)
            onClaudeCodePermissionModeChange?.(mode as ClaudeCodePermissionMode)
        else if (canChooseHermesPermissions)
            onHermesPermissionModeChange?.(mode as HermesPermissionMode)
        else onCodexPermissionModeChange?.(mode as CodexPermissionMode)
    }

    const selectModel = (next: string | null): void => {
        onModelOverrideChange?.(next)
        setModelMenuOpen(false)
    }

    const addFiles = (files: File[]): void => {
        if (files.length === 0) return
        setAttachmentError(null)
        setAttachments((prev) => {
            const next = [...prev]
            let totalBytes = next.reduce(
                (sum, attachment) =>
                    attachment.status === 'error'
                        ? sum
                        : sum + attachment.file.size,
                0
            )
            for (const file of files) {
                if (
                    next.length + contextRefs.length >=
                    CHAT_ATTACHMENT_MAX_COUNT
                ) {
                    setAttachmentError(
                        t('web.composer.attachmentLimit', {
                            max: CHAT_ATTACHMENT_MAX_COUNT
                        })
                    )
                    break
                }
                const error = !isAllowedChatAttachment(file)
                    ? t('web.composer.cannotUpload')
                    : file.size > CHAT_ATTACHMENT_MAX_FILE_BYTES
                      ? t('web.composer.fileTooLarge', {
                            size: formatSize(CHAT_ATTACHMENT_MAX_FILE_BYTES)
                        })
                      : totalBytes + file.size > CHAT_ATTACHMENT_MAX_TOTAL_BYTES
                        ? t('web.composer.attachmentsTooLarge', {
                              size: formatSize(CHAT_ATTACHMENT_MAX_TOTAL_BYTES)
                          })
                        : undefined
                const previewUrl =
                    !error && file.type.startsWith('image/')
                        ? URL.createObjectURL(file)
                        : null
                if (!error) totalBytes += file.size
                next.push({
                    id: createAttachmentId(),
                    file,
                    previewUrl,
                    progress: 0,
                    status: error ? 'error' : 'pending',
                    error
                })
            }
            return next
        })
    }

    const handleAttachmentChange = (): void => {
        const files = Array.from(fileInputRef.current?.files ?? [])
        if (fileInputRef.current) fileInputRef.current.value = ''
        addFiles(files)
    }

    const attachmentsActive = !disabled && !streaming && attachmentsEnabled

    const addFilesRef = useRef(addFiles)
    addFilesRef.current = addFiles
    const attachmentsActiveRef = useRef(attachmentsActive)
    attachmentsActiveRef.current = attachmentsActive

    useEffect(() => {
        const target = dropTargetRef?.current
        if (!target) return
        const hasFiles = (transfer: DataTransfer | null): boolean =>
            transfer != null && Array.from(transfer.types).includes('Files')
        const onDragEnter = (ev: globalThis.DragEvent): void => {
            if (!attachmentsActiveRef.current || !hasFiles(ev.dataTransfer))
                return
            ev.preventDefault()
            dragDepthRef.current += 1
            setIsDragActive(true)
        }
        const onDragOver = (ev: globalThis.DragEvent): void => {
            if (!attachmentsActiveRef.current || !hasFiles(ev.dataTransfer))
                return
            ev.preventDefault()
            if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'
        }
        const onDragLeave = (): void => {
            if (!attachmentsActiveRef.current) return
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
            if (dragDepthRef.current === 0) setIsDragActive(false)
        }
        const onDrop = (ev: globalThis.DragEvent): void => {
            if (!attachmentsActiveRef.current || !hasFiles(ev.dataTransfer))
                return
            ev.preventDefault()
            dragDepthRef.current = 0
            setIsDragActive(false)
            addFilesRef.current(Array.from(ev.dataTransfer?.files ?? []))
        }
        target.addEventListener('dragenter', onDragEnter)
        target.addEventListener('dragover', onDragOver)
        target.addEventListener('dragleave', onDragLeave)
        target.addEventListener('drop', onDrop)
        return () => {
            target.removeEventListener('dragenter', onDragEnter)
            target.removeEventListener('dragover', onDragOver)
            target.removeEventListener('dragleave', onDragLeave)
            target.removeEventListener('drop', onDrop)
        }
    }, [dropTargetRef])

    const handlePaste = (ev: ClipboardEvent<HTMLTextAreaElement>): void => {
        if (!attachmentsActive) return
        const files = Array.from(ev.clipboardData?.files ?? [])
        if (files.length === 0) return
        ev.preventDefault()
        addFiles(files)
    }

    const removeAttachment = (id: string): void => {
        setAttachments((prev) => {
            const removed = prev.find((attachment) => attachment.id === id)
            if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
            return prev.filter((attachment) => attachment.id !== id)
        })
    }

    const handleKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>): void => {
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.nativeEvent.isComposing) {
            ev.preventDefault()
            void submit()
        }
        if (ev.key === 'Escape' && streaming && onStop) {
            ev.preventDefault()
            onStop()
        }
    }

    const frameworkLabel = formatFrameworkLabel(
        framework,
        t('web.composer.agentLabel')
    )
    const modelDefaultLabel = model?.trim() || frameworkLabel
    const modelOverrideValue = modelOverride?.trim() || null
    const hasFrameworkModelConfig = Boolean(
        modelConfigView &&
        (modelConfigView.framework === 'claude-code' ||
            modelConfigView.framework === 'codex' ||
            modelConfigView.framework === 'gemini-cli') &&
        onModelConfigDraftChange
    )
    const draftValidation = validateModelConfigDraft(
        modelConfigView,
        modelConfigDraft,
        t
    )
    const isCodexModelConfig =
        hasFrameworkModelConfig && modelConfigView?.framework === 'codex'
    const isCodexFastSpeed =
        isCodexModelConfig &&
        (modelConfigDraft as { speed?: string } | null)?.speed === 'fast'
    const isClaudeModelConfig =
        hasFrameworkModelConfig && modelConfigView?.framework === 'claude-code'
    const isGeminiModelConfig =
        hasFrameworkModelConfig && modelConfigView?.framework === 'gemini-cli'
    const modelDisplayParts: ComposerLabelParts | null =
        hasFrameworkModelConfig && modelConfigSource !== 'runtime-local'
            ? isCodexModelConfig
                ? formatCodexComposerLabel(
                      modelConfigDraft,
                      modelDefaultLabel,
                      t
                  )
                : isClaudeModelConfig
                  ? formatClaudeComposerLabel(
                        modelConfigDraft,
                        modelDefaultLabel,
                        t
                    )
                  : isGeminiModelConfig
                    ? formatGeminiComposerLabel(
                          modelConfigDraft,
                          modelDefaultLabel
                      )
                    : null
            : null
    const modelDisplayLabel = hasFrameworkModelConfig
        ? modelConfigSource === 'runtime-local'
            ? t('web.credentials.modelSourceLocal')
            : modelDisplayParts
              ? joinComposerLabelParts(modelDisplayParts)
              : modelConfigDisplayLabel(
                    modelConfigView,
                    modelConfigDraft,
                    modelDefaultLabel,
                    t
                )
        : formatModelLabel(modelOverrideValue || modelDefaultLabel)
    const modelBaseTitle = modelOverrideValue
        ? t('web.composer.modelSelectedTitle', {
              model: formatModelLabel(modelOverrideValue)
          })
        : t('web.composer.modelDefaultTitle', {
              model: formatModelLabel(modelDefaultLabel)
          })
    const canChooseModel = Boolean(onModelOverrideChange)
    const modelTitle = hasFrameworkModelConfig
        ? (draftValidation.message ?? t('web.composer.modelSettings'))
        : canChooseModel
          ? modelBaseTitle
          : t('web.composer.modelManagedBy', {
                base: modelBaseTitle,
                framework: frameworkLabel
            })
    const modelButtonDisabled =
        (disabled && !hasFrameworkModelConfig) ||
        streaming ||
        modelPickerDisabled ||
        (!canChooseModel && !hasFrameworkModelConfig)
    const selectableModels = uniqueModels(modelOptions).filter(
        (option) => option !== modelDefaultLabel
    )
    // Provider catalogs (openrouter) run to hundreds of entries; a plain list
    // is unusable past a screenful, so the menu grows a filter box.
    const modelFilterNeedle = modelFilter.trim().toLowerCase()
    const showModelFilter = selectableModels.length > 12
    const filteredModels =
        showModelFilter && modelFilterNeedle
            ? selectableModels.filter((option) =>
                  option.toLowerCase().includes(modelFilterNeedle)
              )
            : selectableModels
    const promptTarget = agentName?.trim() || t('web.composer.theAgent')
    const canSwitchAgent =
        showAgentSwitcher && agentOptions.length > 1 && Boolean(onSelectAgent)
    const selectedAgent =
        agentOptions.find((agent) => agent.id === selectedAgentId) ?? null
    const agentSwitcherLabel =
        selectedAgent?.name ??
        agentName?.trim() ??
        t('web.composer.selectAgent')
    const attachmentErrors = attachments.some(
        (attachment) => attachment.status === 'error'
    )
    const hasSendableAttachments = attachments.some(
        (attachment) => attachment.status !== 'error'
    )
    const canSend =
        Boolean(text.trim()) || hasSendableAttachments || contextRefs.length > 0
    const attachmentButtonDisabled =
        disabled || streaming || !attachmentsEnabled
    const canChooseClaudeCodePermissions =
        framework === 'claude-code' && Boolean(onClaudeCodePermissionModeChange)
    const canChooseCodexPermissions =
        framework === 'codex' && Boolean(onCodexPermissionModeChange)
    const canChooseHermesPermissions =
        framework === 'hermes' && Boolean(onHermesPermissionModeChange)
    const canChoosePermissions =
        canChooseClaudeCodePermissions ||
        canChooseCodexPermissions ||
        canChooseHermesPermissions
    const permissionButtonDisabled =
        disabled || streaming || !canChoosePermissions
    const permissionOptions: Array<
        ComposerPermissionOption<ComposerPermissionMode> & {
            label: string
            title: string
            description: string
        }
    > = (canChooseClaudeCodePermissions
        ? claudeCodePermissionOptions
        : canChooseHermesPermissions
          ? hermesPermissionOptions
          : codexPermissionOptions
    ).map((option) => ({
        ...option,
        label: t(option.labelKey),
        title: t(option.titleKey),
        description: t(option.descriptionKey)
    }))
    const activePermissionMode: ComposerPermissionMode =
        canChooseClaudeCodePermissions
            ? claudeCodePermissionMode
            : canChooseHermesPermissions
              ? hermesPermissionMode
              : codexPermissionMode
    const permissionOption =
        permissionOptions.find(
            (option) => option.value === activePermissionMode
        ) ?? permissionOptions[0]

    return (
        <>
            {isDragActive &&
                dropTargetRef?.current &&
                createPortal(
                    <div className='chat-composer-dropzone'>
                        {t('web.composer.attachmentDropHint')}
                    </div>,
                    dropTargetRef.current
                )}
            <div
                className={
                    variant === 'dock'
                        ? 'chat-composer-dock'
                        : 'chat-composer-inline'
                }
            >
                <div className='chat-composer-shell'>
                    <div
                        className={[
                            'chat-composer-card',
                            disabled ? 'chat-composer-card-disabled' : ''
                        ].join(' ')}
                    >
                        {(attachments.length > 0 || contextRefs.length > 0) && (
                            <div className='chat-composer-attachments'>
                                {contextRefs.map((contextRef) => (
                                    <ContextRefChip
                                        key={contextRef.id}
                                        contextRef={contextRef}
                                        onRemove={
                                            onRemoveContextRef
                                                ? () =>
                                                      onRemoveContextRef(
                                                          contextRef.id
                                                      )
                                                : undefined
                                        }
                                    />
                                ))}
                                {attachments.map((attachment) => (
                                    <AttachmentChip
                                        key={attachment.id}
                                        attachment={attachment}
                                        onRemove={() =>
                                            removeAttachment(attachment.id)
                                        }
                                    />
                                ))}
                            </div>
                        )}
                        {attachmentError && (
                            <div className='chat-composer-attachment-error'>
                                {attachmentError}
                            </div>
                        )}
                        <textarea
                            ref={textareaRef}
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            onKeyDown={handleKeyDown}
                            onPaste={handlePaste}
                            onFocus={onComposeIntent}
                            disabled={disabled}
                            rows={1}
                            placeholder={
                                disabled
                                    ? (hint ??
                                      t('web.composer.chatAdapterPending'))
                                    : t('web.composer.askPlaceholder', {
                                          target: promptTarget
                                      })
                            }
                            className='chat-composer-input'
                        />
                        <div className='chat-composer-toolbar'>
                            <div className='chat-composer-toolbar-left'>
                                <div
                                    ref={attachmentMenuRef}
                                    className='chat-composer-action-root'
                                >
                                    <input
                                        ref={fileInputRef}
                                        type='file'
                                        multiple
                                        accept={CHAT_ATTACHMENT_ACCEPT}
                                        className='hidden'
                                        onChange={handleAttachmentChange}
                                    />
                                    <ShortcutTooltip
                                        label={t('web.composer.openActions')}
                                        placement='top'
                                    >
                                        <button
                                            type='button'
                                            className={[
                                                'chat-composer-plus',
                                                attachmentMenuOpen
                                                    ? 'chat-composer-plus-active'
                                                    : ''
                                            ].join(' ')}
                                            disabled={attachmentButtonDisabled}
                                            aria-label={t(
                                                'web.composer.openActions'
                                            )}
                                            aria-expanded={attachmentMenuOpen}
                                            aria-haspopup='menu'
                                            onClick={toggleAttachmentMenu}
                                        >
                                            <PlusIcon className='h-4 w-4' />
                                        </button>
                                    </ShortcutTooltip>
                                    <ComposerMenu
                                        open={attachmentMenuOpen}
                                        anchorRef={attachmentMenuRef}
                                        panelRef={attachmentMenuPanelRef}
                                        className='popover-panel chat-composer-action-menu'
                                    >
                                        <button
                                            type='button'
                                            role='menuitem'
                                            className='chat-composer-action-item'
                                            onClick={openAttachmentPicker}
                                        >
                                            <PaperclipIcon className='h-4 w-4' />
                                            <span>
                                                {t(
                                                    'web.composer.addPhotosFiles'
                                                )}
                                            </span>
                                        </button>
                                    </ComposerMenu>
                                </div>
                                {canChoosePermissions && (
                                    <div
                                        ref={permissionMenuRef}
                                        className='chat-composer-permission-root'
                                    >
                                        <ShortcutTooltip
                                            label={permissionOption.title}
                                            placement='top'
                                        >
                                            <button
                                                type='button'
                                                className={[
                                                    'chat-composer-permission',
                                                    permissionOption.dangerous
                                                        ? 'chat-composer-permission-full-access'
                                                        : ''
                                                ].join(' ')}
                                                disabled={
                                                    permissionButtonDisabled
                                                }
                                                aria-label={t(
                                                    'web.composer.changePermissions',
                                                    {
                                                        framework:
                                                            frameworkLabel
                                                    }
                                                )}
                                                aria-expanded={
                                                    permissionMenuOpen
                                                }
                                                aria-haspopup='menu'
                                                onClick={togglePermissionMenu}
                                            >
                                                <permissionOption.icon className='chat-composer-permission-icon h-3.5 w-3.5' />
                                                <span className='chat-composer-permission-label'>
                                                    {permissionOption.label}
                                                </span>
                                                <ChevronDownIcon className='h-3.5 w-3.5' />
                                            </button>
                                        </ShortcutTooltip>
                                        <ComposerMenu
                                            open={permissionMenuOpen}
                                            anchorRef={permissionMenuRef}
                                            panelRef={permissionMenuPanelRef}
                                            className='popover-panel chat-composer-permission-menu'
                                        >
                                            <div className='chat-composer-permission-heading'>
                                                {t(
                                                    'web.composer.permissionsHeading',
                                                    {
                                                        framework:
                                                            frameworkLabel
                                                    }
                                                )}
                                            </div>
                                            {permissionOptions.map((option) => {
                                                const active =
                                                    option.value ===
                                                    activePermissionMode
                                                return (
                                                    <ShortcutTooltip
                                                        key={option.value}
                                                        label={option.title}
                                                        className='w-full'
                                                    >
                                                        <button
                                                            type='button'
                                                            role='menuitemradio'
                                                            aria-checked={
                                                                active
                                                            }
                                                            className='chat-composer-permission-option'
                                                            onClick={() => {
                                                                void selectPermissionMode(
                                                                    option.value
                                                                )
                                                            }}
                                                        >
                                                            <option.icon className='chat-composer-permission-option-icon h-4 w-4 shrink-0' />
                                                            <span className='chat-composer-permission-option-text'>
                                                                <span className='chat-composer-permission-option-label'>
                                                                    {
                                                                        option.label
                                                                    }
                                                                </span>
                                                                <span className='chat-composer-permission-option-desc'>
                                                                    {
                                                                        option.description
                                                                    }
                                                                </span>
                                                            </span>
                                                            {active && (
                                                                <CheckIcon className='chat-composer-permission-option-check chat-composer-menu-check h-4 w-4' />
                                                            )}
                                                        </button>
                                                    </ShortcutTooltip>
                                                )
                                            })}
                                        </ComposerMenu>
                                    </div>
                                )}
                            </div>
                            <div className='chat-composer-toolbar-right'>
                                <div
                                    ref={modelMenuRef}
                                    className='chat-composer-model-root'
                                >
                                    <ShortcutTooltip
                                        label={modelTitle}
                                        placement='top'
                                        className='min-w-0'
                                    >
                                        <button
                                            type='button'
                                            className={[
                                                'chat-composer-model',
                                                isCodexModelConfig
                                                    ? 'chat-composer-model-codex'
                                                    : isClaudeModelConfig
                                                      ? 'chat-composer-model-claude'
                                                      : isGeminiModelConfig
                                                        ? 'chat-composer-model-claude'
                                                        : ''
                                            ].join(' ')}
                                            disabled={modelButtonDisabled}
                                            aria-label={t(
                                                'web.composer.changeModel'
                                            )}
                                            aria-expanded={modelMenuOpen}
                                            aria-haspopup='menu'
                                            onClick={toggleModelMenu}
                                        >
                                            {streaming && (
                                                <span className='chat-composer-model-button-icon'>
                                                    <Spinner size={12} />
                                                </span>
                                            )}
                                            {!streaming && isCodexFastSpeed && (
                                                <ZapIcon className='text-muted h-3.5 w-3.5 shrink-0' />
                                            )}
                                            {streaming ? (
                                                <span className='chat-composer-model-name'>
                                                    {t(
                                                        'web.composer.streaming'
                                                    )}
                                                </span>
                                            ) : modelDisplayParts ? (
                                                <span className='chat-composer-model-name'>
                                                    {modelDisplayParts.name}
                                                    {modelDisplayParts.detail && (
                                                        <span className='chat-composer-model-detail'>
                                                            {
                                                                modelDisplayParts.detail
                                                            }
                                                        </span>
                                                    )}
                                                </span>
                                            ) : (
                                                <span className='chat-composer-model-name'>
                                                    {modelDisplayLabel}
                                                </span>
                                            )}
                                            {(canChooseModel ||
                                                hasFrameworkModelConfig) && (
                                                <ChevronDownIcon className='h-3.5 w-3.5' />
                                            )}
                                        </button>
                                    </ShortcutTooltip>
                                    <ComposerMenu
                                        open={modelMenuOpen}
                                        anchorRef={modelMenuRef}
                                        panelRef={modelMenuPanelRef}
                                        align='end'
                                        className={[
                                            'popover-panel chat-composer-model-menu',
                                            hasFrameworkModelConfig
                                                ? 'chat-composer-model-menu-framework'
                                                : '',
                                            isCodexModelConfig
                                                ? 'chat-composer-model-menu-codex'
                                                : ''
                                        ].join(' ')}
                                    >
                                        {hasFrameworkModelConfig &&
                                        modelConfigView ? (
                                            <FrameworkModelConfigMenu
                                                view={modelConfigView}
                                                draft={modelConfigDraft}
                                                source={
                                                    modelConfigSource ??
                                                    modelConfigView.source
                                                }
                                                refreshing={
                                                    modelConfigRefreshing
                                                }
                                                onChange={
                                                    onModelConfigDraftChange
                                                }
                                                onSourceChange={
                                                    onModelConfigSourceChange
                                                }
                                                onRefresh={onRefreshModelConfig}
                                                onOpenSettings={
                                                    onOpenModelSettings
                                                }
                                                onRequestClose={() =>
                                                    setModelMenuOpen(false)
                                                }
                                            />
                                        ) : (
                                            <>
                                                <div className='chat-composer-model-menu-label'>
                                                    {t(
                                                        'web.composer.modelMenuLabel'
                                                    )}
                                                </div>
                                                <ModelMenuItem
                                                    label={t(
                                                        'web.composer.modelDefaultLabel',
                                                        {
                                                            model: formatModelLabel(
                                                                modelDefaultLabel
                                                            )
                                                        }
                                                    )}
                                                    active={
                                                        modelOverrideValue ===
                                                        null
                                                    }
                                                    onSelect={() =>
                                                        selectModel(null)
                                                    }
                                                />
                                                {selectableModels.length >
                                                    0 && (
                                                    <div className='popover-separator' />
                                                )}
                                                {showModelFilter && (
                                                    <input
                                                        type='text'
                                                        value={modelFilter}
                                                        onChange={(e) =>
                                                            setModelFilter(
                                                                e.target.value
                                                            )
                                                        }
                                                        placeholder={t(
                                                            'web.composer.modelFilterPlaceholder'
                                                        )}
                                                        aria-label={t(
                                                            'web.composer.modelFilterPlaceholder'
                                                        )}
                                                        className='bg-app text-body-sm placeholder:text-placeholder mx-2 my-1 w-[calc(100%-1rem)] rounded-md px-2 py-1 outline-none'
                                                    />
                                                )}
                                                {showModelFilter &&
                                                    filteredModels.length ===
                                                        0 && (
                                                        <div className='text-caption text-subtle px-3 py-2'>
                                                            {t(
                                                                'web.composer.modelNoMatches'
                                                            )}
                                                        </div>
                                                    )}
                                                {filteredModels.map(
                                                    (option) => (
                                                        <ModelMenuItem
                                                            key={option}
                                                            label={formatModelLabel(
                                                                option
                                                            )}
                                                            active={
                                                                modelOverrideValue ===
                                                                option
                                                            }
                                                            onSelect={() =>
                                                                selectModel(
                                                                    option
                                                                )
                                                            }
                                                        />
                                                    )
                                                )}
                                            </>
                                        )}
                                    </ComposerMenu>
                                </div>
                                <ShortcutTooltip
                                    label={
                                        streaming
                                            ? t('web.composer.stopResponse')
                                            : t('web.composer.sendHint')
                                    }
                                    placement='top'
                                >
                                    <button
                                        type='button'
                                        onClick={
                                            streaming
                                                ? onStop
                                                : () => void submit()
                                        }
                                        disabled={
                                            streaming
                                                ? !onStop
                                                : disabled ||
                                                  !canSend ||
                                                  attachmentErrors
                                        }
                                        className={`chat-composer-send ${
                                            streaming
                                                ? 'chat-composer-send-stop'
                                                : ''
                                        }`}
                                        aria-label={
                                            streaming
                                                ? t('web.composer.stopResponse')
                                                : t('web.composer.sendMessage')
                                        }
                                    >
                                        {streaming ? (
                                            <StopIcon
                                                className='h-3.5 w-3.5'
                                                fill='currentColor'
                                                stroke='none'
                                            />
                                        ) : (
                                            <ArrowUpIcon className='h-4 w-4' />
                                        )}
                                    </button>
                                </ShortcutTooltip>
                            </div>
                        </div>
                    </div>
                    {canSwitchAgent && (
                        <div
                            className='chat-composer-context'
                            aria-label={t('web.composer.agentContext')}
                        >
                            <div
                                ref={agentSwitcherRef}
                                className='chat-composer-agent-switcher'
                            >
                                <ShortcutTooltip
                                    label={t('web.composer.switchAgent')}
                                    placement='top'
                                    className='min-w-0'
                                >
                                    <button
                                        type='button'
                                        onClick={() =>
                                            setAgentMenuOpen((prev) => {
                                                setAttachmentMenuOpen(false)
                                                setModelMenuOpen(false)
                                                return !prev
                                            })
                                        }
                                        className='chat-composer-agent-button'
                                        aria-expanded={agentMenuOpen}
                                        aria-haspopup='menu'
                                    >
                                        <FrameworkLogoIcon
                                            framework={
                                                selectedAgent?.framework ??
                                                framework
                                            }
                                            className='h-4 w-4'
                                        />
                                        <span className='chat-composer-agent-button-label'>
                                            {agentSwitcherLabel}
                                        </span>
                                        <ChevronDownIcon className='h-3.5 w-3.5' />
                                    </button>
                                </ShortcutTooltip>
                                <ComposerMenu
                                    open={agentMenuOpen}
                                    anchorRef={agentSwitcherRef}
                                    panelRef={agentMenuPanelRef}
                                    className='popover-panel chat-composer-agent-menu'
                                >
                                    {agentOptions.map((agent) => {
                                        const active =
                                            agent.id === selectedAgentId
                                        return (
                                            <ShortcutTooltip
                                                key={agent.id}
                                                label={
                                                    agent.disabled
                                                        ? agent.disabledReason
                                                        : undefined
                                                }
                                                className='w-full'
                                            >
                                                <button
                                                    type='button'
                                                    role='menuitem'
                                                    disabled={agent.disabled}
                                                    onClick={() => {
                                                        if (agent.disabled)
                                                            return
                                                        setAgentMenuOpen(false)
                                                        onSelectAgent?.(
                                                            agent.id
                                                        )
                                                    }}
                                                    className='chat-composer-agent-option'
                                                >
                                                    <FrameworkLogoIcon
                                                        framework={
                                                            agent.framework
                                                        }
                                                        className='mt-0.5 h-4 w-4'
                                                    />
                                                    <span className='min-w-0 flex-1'>
                                                        <span className='chat-composer-agent-option-name'>
                                                            {agent.name}
                                                        </span>
                                                        <span className='chat-composer-agent-option-meta'>
                                                            {formatFrameworkLabel(
                                                                agent.framework,
                                                                t('web.composer.agentLabel')
                                                            )}
                                                            {agent.status
                                                                ? ` - ${formatStatusLabel(
                                                                      agent.status,
                                                                      t
                                                                  )}`
                                                                : ''}
                                                        </span>
                                                    </span>
                                                    {active && (
                                                        <CheckIcon className='chat-composer-menu-check h-3.5 w-3.5' />
                                                    )}
                                                </button>
                                            </ShortcutTooltip>
                                        )
                                    })}
                                </ComposerMenu>
                            </div>
                        </div>
                    )}
                </div>
            </div>
            {confirmDialog}
        </>
    )
}

interface AttachmentChipProps {
    attachment: PendingAttachment
    onRemove: () => void
}

const ATTACHMENT_CODE_EXTENSIONS = new Set([
    'html',
    'htm',
    'css',
    'scss',
    'sass',
    'less',
    'js',
    'jsx',
    'ts',
    'tsx',
    'mjs',
    'cjs',
    'json',
    'xml',
    'yaml',
    'yml',
    'toml',
    'ini',
    'env',
    'py',
    'rb',
    'go',
    'rs',
    'java',
    'kt',
    'c',
    'h',
    'cpp',
    'hpp',
    'cc',
    'cs',
    'php',
    'swift',
    'sh',
    'bash',
    'zsh',
    'sql',
    'vue',
    'svelte'
])
const ATTACHMENT_SHEET_EXTENSIONS = new Set(['csv', 'tsv', 'xls', 'xlsx'])
const ATTACHMENT_DOC_EXTENSIONS = new Set([
    'pdf',
    'doc',
    'docx',
    'rtf',
    'txt',
    'log',
    'md',
    'markdown',
    'ppt',
    'pptx'
])
const ATTACHMENT_ARCHIVE_EXTENSIONS = new Set([
    'zip',
    'tar',
    'gz',
    'tgz',
    'rar',
    '7z'
])

const attachmentVisual = (file: File): { Icon: LucideIcon; label: string } => {
    const dot = file.name.lastIndexOf('.')
    const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : ''
    const label = ext
        ? ext.toUpperCase()
        : (file.type.split('/')[1]?.toUpperCase() ?? 'FILE')
    if (ATTACHMENT_CODE_EXTENSIONS.has(ext)) return { Icon: CodeIcon, label }
    if (ATTACHMENT_SHEET_EXTENSIONS.has(ext))
        return { Icon: FileSpreadsheetIcon, label }
    if (ATTACHMENT_DOC_EXTENSIONS.has(ext)) return { Icon: FileTextIcon, label }
    if (ATTACHMENT_ARCHIVE_EXTENSIONS.has(ext))
        return { Icon: FileArchiveIcon, label }
    return { Icon: FileIcon, label }
}

const AttachmentChip: FC<AttachmentChipProps> = ({
    attachment,
    onRemove
}): ReactNode => {
    const { t } = useI18n()
    const isImage =
        attachment.file.type.startsWith('image/') &&
        Boolean(attachment.previewUrl)
    const fallbackName = t('web.composer.attachmentFallbackName')
    const name = attachment.file.name || fallbackName
    const visual = attachmentVisual(attachment.file)
    const metaText =
        attachment.status === 'uploading'
            ? `${Math.round(attachment.progress * 100)}%`
            : attachment.status === 'uploaded'
              ? t('web.composer.uploaded')
              : attachment.status === 'error'
                ? attachment.error || t('web.composer.cannotUpload')
                : visual.label
    const isErrorMeta = attachment.status === 'error'
    const title = `${name} · ${metaText}${
        attachment.path ? ` · ${attachment.path}` : ''
    }`
    const removeButton = (
        <button
            type='button'
            className='chat-composer-attachment-remove'
            aria-label={t('web.composer.removeAttachment', { name })}
            onClick={onRemove}
        >
            <CloseIcon className='h-3 w-3' />
        </button>
    )
    const progressBar = attachment.status === 'uploading' && (
        <span
            className='chat-composer-attachment-progress'
            style={{ width: `${Math.max(4, attachment.progress * 100)}%` }}
        />
    )

    if (isImage) {
        return (
            <ShortcutTooltip label={title} placement='top' className='shrink-0'>
                <div
                    className={[
                        'chat-composer-attachment',
                        'chat-composer-attachment-image',
                        attachment.status === 'error'
                            ? 'chat-composer-attachment-error-state'
                            : ''
                    ].join(' ')}
                >
                    <img
                        className='chat-composer-attachment-thumb'
                        src={attachment.previewUrl ?? ''}
                        alt={name}
                    />
                    {progressBar}
                    {removeButton}
                </div>
            </ShortcutTooltip>
        )
    }

    return (
        <ShortcutTooltip label={title} placement='top' className='shrink-0'>
            <div
                className={[
                    'chat-composer-attachment',
                    'chat-composer-attachment-file',
                    attachment.status === 'error'
                        ? 'chat-composer-attachment-error-state'
                        : ''
                ].join(' ')}
            >
                <span className='chat-composer-attachment-icon'>
                    <visual.Icon className='h-5 w-5' />
                </span>
                <span className='chat-composer-attachment-body'>
                    <span className='chat-composer-attachment-name'>
                        {name}
                    </span>
                    <span
                        className={[
                            'chat-composer-attachment-meta',
                            isErrorMeta
                                ? 'chat-composer-attachment-meta-error'
                                : ''
                        ].join(' ')}
                    >
                        {metaText}
                    </span>
                </span>
                {progressBar}
                {removeButton}
            </div>
        </ShortcutTooltip>
    )
}

const ContextRefChip: FC<{
    contextRef: ComposerContextRef
    onRemove?: () => void
}> = ({ contextRef, onRemove }): ReactNode => {
    const { t } = useI18n()
    const Icon = contextRef.entryType === 'dir' ? FolderIcon : FileIcon
    const meta =
        contextRef.entryType === 'file' && contextRef.size !== undefined
            ? formatSize(contextRef.size)
            : contextRef.entryType === 'dir'
              ? t('web.composer.folderContext')
              : t('web.composer.fileContext')
    return (
        <ShortcutTooltip
            label={`${contextRef.name} - ${contextRef.path}`}
            placement='top'
            className='shrink-0'
        >
            <div className='chat-composer-attachment chat-composer-attachment-file'>
                <span className='chat-composer-attachment-icon'>
                    <Icon className='h-5 w-5' />
                </span>
                <span className='chat-composer-attachment-body'>
                    <span className='chat-composer-attachment-name'>
                        {contextRef.name}
                    </span>
                    <span className='chat-composer-attachment-meta'>
                        {meta}
                    </span>
                </span>
                {onRemove && (
                    <button
                        type='button'
                        className='chat-composer-attachment-remove'
                        aria-label={t('web.composer.removeAttachment', {
                            name: contextRef.name
                        })}
                        onClick={onRemove}
                    >
                        <CloseIcon className='h-3 w-3' />
                    </button>
                )}
            </div>
        </ShortcutTooltip>
    )
}

interface ModelMenuItemProps {
    label: string
    active: boolean
    onSelect: () => void
}

interface FrameworkModelConfigMenuProps {
    view: AgentModelConfigView
    draft: AgentModelConfig | null
    source: AgentModelConfigSource
    refreshing: boolean
    onChange?: (config: AgentModelConfig) => void
    onSourceChange?: (source: AgentModelConfigSource) => void
    onRefresh?: (source?: AgentModelConfigSource) => Promise<void> | void
    onOpenSettings?: () => void
    onRequestClose?: () => void
}

const FrameworkModelConfigMenu: FC<FrameworkModelConfigMenuProps> = ({
    view,
    draft,
    source,
    refreshing,
    onChange,
    onSourceChange,
    onRefresh,
    onOpenSettings,
    onRequestClose
}): ReactNode => {
    const { t } = useI18n()
    const [refreshingSource, setRefreshingSource] =
        useState<AgentModelConfigSource | null>(null)
    useEffect(() => {
        if (!refreshing) setRefreshingSource(null)
    }, [refreshing])
    const effectiveView = { ...view, source }
    const validation = validateModelConfigDraft(effectiveView, draft, t)
    const runtimeLocal = source === 'runtime-local'
    const runtimeLocalReady = view.runtimeLocal?.ready === true
    const hasSourceChoice = view.availableSources.includes('runtime-local')
    const platformReady = effectiveView.providerModelsStatus === 'ready'
    const showValidationMessage = Boolean(
        validation.message && !(runtimeLocal && !runtimeLocalReady)
    )

    const healthReady = runtimeLocal ? runtimeLocalReady : platformReady
    const healthModelCount = runtimeLocal
        ? (view.runtimeLocal?.models.length ?? 0)
        : view.providerModels.length
    const currentHealth = {
        ready: healthReady,
        label: healthReady
            ? healthModelCount > 0
                ? t('web.composer.readyModels', { count: healthModelCount })
                : t('web.composer.ready')
            : t('web.composer.notChecked')
    }

    return (
        <>
            <div className='chat-composer-model-menu-header'>
                <div className='chat-composer-model-menu-title'>
                    {t('web.credentials.modelSourceLabel')}
                </div>
            </div>
            {hasSourceChoice && (
                <div className='chat-composer-source-panel'>
                    <ModelSourceSwitch
                        source={source}
                        onSelect={(next) => onSourceChange?.(next)}
                    />
                    <div className='chat-composer-model-source-statusrow'>
                        <span className='chat-composer-model-source-status'>
                            <span
                                className={[
                                    'chat-composer-model-source-state',
                                    currentHealth.ready
                                        ? 'chat-composer-model-source-state-ready'
                                        : 'chat-composer-model-source-state-warn'
                                ].join(' ')}
                            >
                                <span
                                    aria-hidden='true'
                                    className='chat-composer-model-source-state-dot'
                                />
                                <span className='min-w-0 truncate'>
                                    {currentHealth.label}
                                </span>
                            </span>
                            <ShortcutTooltip label={t('web.composer.refresh')}>
                                <button
                                    type='button'
                                    className='chat-composer-model-source-iconbtn'
                                    disabled={refreshing || !onRefresh}
                                    aria-label={t('web.composer.refresh')}
                                    onClick={() => {
                                        setRefreshingSource(source)
                                        void onRefresh?.(source)
                                    }}
                                >
                                    {refreshing &&
                                    refreshingSource === source ? (
                                        <Spinner size={12} />
                                    ) : (
                                        <RefreshIcon className='h-3.5 w-3.5' />
                                    )}
                                </button>
                            </ShortcutTooltip>
                        </span>
                        {!runtimeLocal && (
                            <button
                                type='button'
                                className='chat-composer-model-source-verify'
                                onClick={() => {
                                    onOpenSettings?.()
                                    onRequestClose?.()
                                }}
                            >
                                <SettingsIcon className='h-3.5 w-3.5' />
                                <span>{t('web.composer.configure')}</span>
                            </button>
                        )}
                    </div>
                </div>
            )}
            {showValidationMessage && validation.message && (
                <ModelInlineNotice
                    message={validation.message}
                    actionLabel={
                        runtimeLocal && onRefresh
                            ? refreshing
                                ? t('web.composer.refreshing')
                                : t('web.composer.refresh')
                            : view.validation.cta === 'configure-claude-mapping'
                              ? t('web.composer.configure')
                              : undefined
                    }
                    actionDisabled={refreshing}
                    href={
                        view.validation.cta === 'configure-claude-mapping'
                            ? `${agentSettingsPath(view.agentId, 'model')}?configureModel=1`
                            : undefined
                    }
                    onAction={
                        runtimeLocal && onRefresh
                            ? () => void onRefresh('runtime-local')
                            : undefined
                    }
                />
            )}
            {runtimeLocal && runtimeLocalReady && (
                <>
                    <RuntimeLocalModelMenu
                        view={view}
                        draft={draft}
                        onChange={onChange}
                        onRequestClose={onRequestClose}
                    />
                    <RuntimeLocalModelSummary view={view} />
                </>
            )}
            {!runtimeLocal && (
                <>
                    <div className='popover-separator' />
                    <div className='chat-composer-model-section-heading pb-0'>
                        <span className='min-w-0 flex-1 truncate'>
                            {t('web.composer.modelSettings')}
                        </span>
                    </div>
                </>
            )}
            {!runtimeLocal && view.framework === 'claude-code' && (
                <ClaudeModelConfigMenu
                    view={view}
                    draft={draft?.framework === 'claude-code' ? draft : null}
                    onChange={onChange}
                    onRequestClose={onRequestClose}
                />
            )}
            {!runtimeLocal && view.framework === 'codex' && (
                <CodexModelConfigMenu
                    view={view}
                    draft={draft?.framework === 'codex' ? draft : null}
                    onChange={onChange}
                    onRequestClose={onRequestClose}
                />
            )}
            {!runtimeLocal && view.framework === 'gemini-cli' && (
                <GeminiModelConfigMenu
                    view={view}
                    draft={draft?.framework === 'gemini-cli' ? draft : null}
                    onChange={onChange}
                    onRequestClose={onRequestClose}
                />
            )}
        </>
    )
}

const ModelInlineNotice: FC<{
    message: string
    actionLabel?: string
    actionDisabled?: boolean
    href?: string
    onAction?: () => void
}> = ({ actionDisabled, actionLabel, href, message, onAction }): ReactNode => (
    <div className='chat-composer-model-inline-notice'>
        <span className='chat-composer-model-inline-notice-dot' />
        <span className='chat-composer-model-inline-notice-text'>
            {message}
        </span>
        {actionLabel &&
            (href ? (
                <a
                    href={href}
                    className='chat-composer-model-inline-notice-action'
                >
                    {actionLabel}
                </a>
            ) : (
                <button
                    type='button'
                    className='chat-composer-model-inline-notice-action'
                    disabled={actionDisabled}
                    onClick={onAction}
                >
                    {actionLabel}
                </button>
            ))}
    </div>
)

// The local list is flat strings — no alias/modelMap cascade and no provider
// options to intersect — so it gets its own menu rather than bending the three
// platform ones. Every knob offers "CLI default", which clears it so the local
// CLI keeps deciding.
const RuntimeLocalModelMenu: FC<{
    view: AgentModelConfigView
    draft: AgentModelConfig | null
    onChange?: (config: AgentModelConfig) => void
    onRequestClose?: () => void
}> = ({ view, draft, onChange, onRequestClose }): ReactNode => {
    const { t } = useI18n()
    const [submenu, setSubmenu] = useState<
        'model' | 'effort' | 'speed' | 'intelligence' | null
    >(null)
    const options = runtimeLocalModelOptions(view)
    if (options.length === 0) return null

    const cliDefault = t('web.credentials.runtimeLocal.cliDefault')
    const selectedModel = draft?.model?.trim() || null
    const patch = (
        next: Parameters<typeof patchRuntimeLocalDraft>[2],
        close = true
    ): void => {
        onChange?.(patchRuntimeLocalDraft(view.framework, draft, next))
        if (close) onRequestClose?.()
    }
    const branch = (
        key: typeof submenu,
        label: string,
        value: string
    ): ReactNode => (
        <button
            type='button'
            className='chat-composer-model-option'
            onClick={() =>
                setSubmenu((current) => (current === key ? null : key))
            }
        >
            <span className='chat-composer-codex-branch-copy'>
                <span className='chat-composer-codex-branch-label'>
                    {label}
                </span>
                <span className='chat-composer-codex-branch-value'>
                    {value}
                </span>
            </span>
            <ChevronRightIcon className='text-muted h-4 w-4 shrink-0' />
        </button>
    )
    const codexDraft = draft?.framework === 'codex' ? draft : null
    const claudeDraft = draft?.framework === 'claude-code' ? draft : null

    return (
        <>
            <div className='popover-separator' />
            <div className='chat-composer-model-section-heading pb-0'>
                <span className='min-w-0 flex-1 truncate'>
                    {t('web.credentials.runtimeLocal.modelsFrom')}
                </span>
            </div>
            <div className='chat-composer-claude-menu'>
                {branch(
                    'model',
                    t('web.composer.model'),
                    selectedModel ?? cliDefault
                )}
                {view.framework === 'claude-code' &&
                    branch(
                        'effort',
                        t('web.composer.effort'),
                        claudeDraft?.effort
                            ? formatClaudeEffortLabel(claudeDraft.effort, t)
                            : cliDefault
                    )}
                {view.framework === 'codex' &&
                    branch(
                        'speed',
                        t('web.composer.speed'),
                        codexDraft?.speed
                            ? formatCodexSpeedLabel(codexDraft.speed, t)
                            : cliDefault
                    )}
                {view.framework === 'codex' &&
                    branch(
                        'intelligence',
                        t('web.composer.reasoning'),
                        codexDraft?.intelligence
                            ? formatCodexIntelligenceLabel(
                                  codexDraft.intelligence,
                                  t
                              )
                            : cliDefault
                    )}
                {submenu === 'model' && (
                    <SubmenuPanel
                        title={t('web.credentials.runtimeLocal.pickModel')}
                        count={options.length}
                    >
                        <ModelMenuItem
                            label={cliDefault}
                            active={!selectedModel}
                            onSelect={() => patch({ model: null })}
                        />
                        {options.map((option) => (
                            <ModelMenuItem
                                key={option}
                                label={option}
                                active={selectedModel === option}
                                onSelect={() => patch({ model: option })}
                            />
                        ))}
                    </SubmenuPanel>
                )}
                {submenu === 'effort' && (
                    <SubmenuPanel title={t('web.composer.effort')}>
                        <ModelMenuItem
                            label={cliDefault}
                            active={!claudeDraft?.effort}
                            onSelect={() => patch({ effort: null })}
                        />
                        {claudeCodeEfforts.map((effort) => (
                            <ModelMenuItem
                                key={effort}
                                label={formatClaudeEffortLabel(effort, t)}
                                active={claudeDraft?.effort === effort}
                                onSelect={() => patch({ effort })}
                            />
                        ))}
                    </SubmenuPanel>
                )}
                {submenu === 'speed' && (
                    <SubmenuPanel title={t('web.composer.speed')}>
                        <ModelMenuItem
                            label={cliDefault}
                            active={!codexDraft?.speed}
                            onSelect={() => patch({ speed: null })}
                        />
                        {codexSpeeds.map((speed) => (
                            <ModelMenuItem
                                key={speed}
                                label={formatCodexSpeedLabel(speed, t)}
                                active={codexDraft?.speed === speed}
                                onSelect={() => patch({ speed })}
                            />
                        ))}
                    </SubmenuPanel>
                )}
                {submenu === 'intelligence' && (
                    <SubmenuPanel title={t('web.composer.reasoning')}>
                        <ModelMenuItem
                            label={cliDefault}
                            active={!codexDraft?.intelligence}
                            onSelect={() => patch({ intelligence: null })}
                        />
                        {codexIntelligenceLevels.map((level) => (
                            <ModelMenuItem
                                key={level}
                                label={formatCodexIntelligenceLabel(level, t)}
                                active={codexDraft?.intelligence === level}
                                onSelect={() => patch({ intelligence: level })}
                            />
                        ))}
                    </SubmenuPanel>
                )}
            </div>
        </>
    )
}

const RuntimeLocalModelSummary: FC<{
    view: AgentModelConfigView
}> = ({ view }): ReactNode => {
    const { t } = useI18n()
    const local = view.runtimeLocal
    const rows: Array<{ label: string; value: string; mono?: boolean }> = []
    if (local?.current)
        rows.push({ label: t('web.composer.config'), value: local.current })
    if (local?.cliVersion)
        rows.push({ label: t('web.composer.cli'), value: local.cliVersion, mono: true })
    if (local?.lastCheckedAt)
        rows.push({
            label: t('web.composer.checked'),
            value: formatDateTime(local.lastCheckedAt)
        })
    return (
        <>
            <div className='popover-separator' />
            <dl className='chat-composer-runtime-local'>
                {rows.length === 0 && !local?.error && (
                    <div className='chat-composer-runtime-local-empty'>
                        {t('web.composer.notCheckedYet')}
                    </div>
                )}
                {rows.map((row) => (
                    <div
                        key={row.label}
                        className='chat-composer-runtime-local-row'
                    >
                        <dt className='chat-composer-runtime-local-label'>
                            {row.label}
                        </dt>
                        <dd
                            className={[
                                'chat-composer-runtime-local-value',
                                row.mono ? 'font-mono' : ''
                            ].join(' ')}
                        >
                            {row.value}
                        </dd>
                    </div>
                ))}
                {local?.error && (
                    <div className='chat-composer-runtime-local-error'>
                        {local.error}
                    </div>
                )}
            </dl>
        </>
    )
}

const ClaudeModelConfigMenu: FC<{
    view: AgentModelConfigView
    draft: Extract<AgentModelConfig, { framework: 'claude-code' }> | null
    onChange?: (config: AgentModelConfig) => void
    onRequestClose?: () => void
}> = ({ view, draft, onChange, onRequestClose }): ReactNode => {
    const { t } = useI18n()
    const [submenu, setSubmenu] = useState<'model' | 'effort' | null>(null)
    const currentDraft = draft ? normalizeClaudeModelConfigDraft(draft) : null
    const options = resolveClaudeCodeModelOptions(
        view.providerModels,
        currentDraft?.modelMap
    )
    const effortOptions = claudeEffortOptionsForDraft(currentDraft)
    const currentEffort = currentDraft?.effort ?? null
    const selectedModel = options.find(
        (option) => option.value === currentDraft?.model
    )
    return (
        <div className='chat-composer-claude-menu'>
            <button
                type='button'
                className='chat-composer-model-option'
                onClick={() =>
                    setSubmenu((current) =>
                        current === 'model' ? null : 'model'
                    )
                }
            >
                <span className='chat-composer-codex-branch-copy'>
                    <span className='chat-composer-codex-branch-label'>
                        {t('web.composer.model')}
                    </span>
                    <span className='chat-composer-codex-branch-value'>
                            {selectedModel
                                ? selectedModel.label
                                : t('web.composer.chooseModel')}
                    </span>
                </span>
                <ChevronRightIcon className='text-muted h-4 w-4 shrink-0' />
            </button>
            {effortOptions.length > 0 && (
                <button
                    type='button'
                    className='chat-composer-model-option'
                    onClick={() =>
                        setSubmenu((current) =>
                            current === 'effort' ? null : 'effort'
                        )
                    }
                >
                    <span className='chat-composer-codex-branch-copy'>
                        <span className='chat-composer-codex-branch-label'>
                            {t('web.composer.effort')}
                        </span>
                        <span className='chat-composer-codex-branch-value'>
                            {currentEffort
                                ? formatClaudeEffortLabel(currentEffort, t)
                                : t('web.composer.default')}
                        </span>
                    </span>
                    <ChevronRightIcon className='text-muted h-4 w-4 shrink-0' />
                </button>
            )}
            {submenu === 'model' && (
                <SubmenuPanel
                    title={t('web.composer.models')}
                    count={options.length}
                >
                    {options.map((option) => {
                        const active = currentDraft?.model === option.value
                        const detail =
                            !option.enabled && option.reason
                                ? option.reason
                                : isClaudeCodeModelAlias(option.value)
                                  ? option.providerModel
                                  : null
                        return (
                            <ShortcutTooltip
                                key={option.value}
                                label={option.reason ?? undefined}
                                className='w-full'
                            >
                                <button
                                    type='button'
                                    role='menuitemradio'
                                    aria-checked={active}
                                    disabled={!option.enabled}
                                    className='chat-composer-model-option'
                                    onClick={() => {
                                        onChange?.(
                                            withClaudeModel(
                                                currentDraft,
                                                option.value
                                            )
                                        )
                                        onRequestClose?.()
                                    }}
                                >
                                    <span className='chat-composer-model-option-copy'>
                                        <span className='chat-composer-model-option-title'>
                                            {option.label}
                                        </span>
                                        {detail && (
                                            <span className='chat-composer-model-option-detail'>
                                                {detail}
                                            </span>
                                        )}
                                    </span>
                                    {active && (
                                        <CheckIcon className='chat-composer-menu-check ml-auto h-4 w-4' />
                                    )}
                                </button>
                            </ShortcutTooltip>
                        )
                    })}
                </SubmenuPanel>
            )}
            {submenu === 'effort' && effortOptions.length > 0 && (
                <SubmenuPanel title={t('web.composer.effort')}>
                    {effortOptions.map((effort) => (
                        <button
                            key={effort}
                            type='button'
                            role='menuitemradio'
                            aria-checked={currentEffort === effort}
                            className='chat-composer-model-option'
                            onClick={() => {
                                onChange?.(withClaudeEffort(draft, effort))
                                onRequestClose?.()
                            }}
                        >
                            <span className='min-w-0 flex-1 truncate'>
                                {formatClaudeEffortLabel(effort, t)}
                            </span>
                            {currentEffort === effort && (
                                <CheckIcon className='chat-composer-menu-check h-4 w-4' />
                            )}
                        </button>
                    ))}
                </SubmenuPanel>
            )}
        </div>
    )
}

const CodexModelConfigMenu: FC<{
    view: AgentModelConfigView
    draft: Extract<AgentModelConfig, { framework: 'codex' }> | null
    onChange?: (config: AgentModelConfig) => void
    onRequestClose?: () => void
}> = ({ view, draft, onChange, onRequestClose }): ReactNode => {
    const { t } = useI18n()
    const [submenu, setSubmenu] = useState<
        'intelligence' | 'model' | 'speed' | null
    >(null)
    const selected = view.options.find(
        (option) => option.value === draft?.model
    )
    const fastDisabled = !selected?.supportsFast
    const currentSpeed = draft?.speed ?? 'standard'
    const currentIntelligence = draft?.intelligence ?? 'medium'

    const selectCodexModel = (model: string, supportsFast?: boolean): void => {
        const next = withCodexModel(draft, model)
        if (next.speed === 'fast' && !supportsFast) next.speed = 'standard'
        onChange?.(next)
        onRequestClose?.()
    }

    return (
        <div className='chat-composer-codex-menu'>
            <button
                type='button'
                className='chat-composer-model-option'
                onClick={() =>
                    setSubmenu((current) =>
                        current === 'intelligence' ? null : 'intelligence'
                    )
                }
            >
                <span className='chat-composer-codex-branch-copy'>
                    <span className='chat-composer-codex-branch-label'>
                        {t('web.composer.reasoning')}
                    </span>
                    <span className='chat-composer-codex-branch-value'>
                        {formatCodexIntelligenceLabel(currentIntelligence, t)}
                    </span>
                </span>
                <ChevronRightIcon className='text-muted h-4 w-4 shrink-0' />
            </button>
            <button
                type='button'
                className='chat-composer-model-option'
                onClick={() =>
                    setSubmenu((current) =>
                        current === 'model' ? null : 'model'
                    )
                }
            >
                <span className='chat-composer-codex-branch-copy'>
                    <span className='chat-composer-codex-branch-label'>
                        {t('web.composer.model')}
                    </span>
                    <span className='chat-composer-codex-branch-value'>
                        {currentSpeed === 'fast' && selected?.supportsFast && (
                            <ZapIcon className='mr-1.5 inline h-3.5 w-3.5 align-[-0.125em]' />
                        )}
                        {selected
                            ? formatCodexModelLabel(selected.value)
                            : t('web.composer.chooseModel')}
                    </span>
                </span>
                <ChevronRightIcon className='text-muted h-4 w-4 shrink-0' />
            </button>
            <button
                type='button'
                className='chat-composer-model-option'
                onClick={() =>
                    setSubmenu((current) =>
                        current === 'speed' ? null : 'speed'
                    )
                }
            >
                <span className='chat-composer-codex-branch-copy'>
                    <span className='chat-composer-codex-branch-label'>
                        {t('web.composer.speed')}
                    </span>
                    <span className='chat-composer-codex-branch-value'>
                        {currentSpeed === 'fast' && (
                            <ZapIcon className='mr-1.5 inline h-3.5 w-3.5 align-[-0.125em]' />
                        )}
                        {formatCodexSpeedLabel(currentSpeed, t)}
                    </span>
                </span>
                <ChevronRightIcon className='text-muted h-4 w-4 shrink-0' />
            </button>
            {submenu === 'intelligence' && (
                <SubmenuPanel title={t('web.composer.reasoning')}>
                    {codexIntelligenceOptionsForModel(draft?.model).map(
                        (level) => (
                            <button
                                key={level}
                                type='button'
                                role='menuitemradio'
                                aria-checked={currentIntelligence === level}
                                className='chat-composer-model-option'
                                onClick={() => {
                                    onChange?.(
                                        withCodexIntelligence(
                                            draft,
                                            level as CodexIntelligence
                                        )
                                    )
                                    onRequestClose?.()
                                }}
                            >
                                <span className='min-w-0 flex-1 truncate'>
                                    {formatCodexIntelligenceLabel(level, t)}
                                </span>
                                {currentIntelligence === level && (
                                    <CheckIcon className='chat-composer-menu-check h-4 w-4' />
                                )}
                            </button>
                        )
                    )}
                </SubmenuPanel>
            )}
            {submenu === 'model' && (
                <SubmenuPanel title={t('web.composer.model')}>
                    {view.options.length === 0 ? (
                        <div className='chat-composer-model-warning'>
                            <InfoIcon className='mt-0.5 h-3.5 w-3.5 shrink-0' />
                            {t('web.composer.supportedCodexModel')}
                        </div>
                    ) : (
                        view.options.map((option) => (
                            <ShortcutTooltip
                                key={option.value}
                                label={option.reason ?? undefined}
                                className='w-full'
                            >
                                <button
                                    type='button'
                                    role='menuitemradio'
                                    aria-checked={draft?.model === option.value}
                                    disabled={!option.enabled}
                                    className='chat-composer-model-option'
                                    onClick={() =>
                                        selectCodexModel(
                                            option.value,
                                            option.supportsFast
                                        )
                                    }
                                >
                                    {currentSpeed === 'fast' &&
                                        option.supportsFast && (
                                            <ZapIcon className='h-4 w-4 shrink-0' />
                                        )}
                                    <span className='chat-composer-model-option-copy'>
                                        <span className='chat-composer-model-option-title'>
                                            {formatCodexModelLabel(
                                                option.value
                                            )}
                                        </span>
                                        {formatCodexProviderModelDetail(
                                            option.value
                                        ) && (
                                            <span className='chat-composer-model-option-detail'>
                                                {formatCodexProviderModelDetail(
                                                    option.value
                                                )}
                                            </span>
                                        )}
                                    </span>
                                    {draft?.model === option.value && (
                                        <CheckIcon className='chat-composer-menu-check h-4 w-4' />
                                    )}
                                </button>
                            </ShortcutTooltip>
                        ))
                    )}
                </SubmenuPanel>
            )}
            {submenu === 'speed' && (
                <SubmenuPanel title={t('web.composer.speed')}>
                    {codexSpeedOptions.map((speed) => {
                        const disabled = speed === 'fast' && fastDisabled
                        return (
                            <ShortcutTooltip
                                key={speed}
                                label={
                                    disabled
                                        ? t('web.composer.fastUnavailable')
                                        : undefined
                                }
                                className='w-full'
                            >
                                <button
                                    type='button'
                                    role='menuitemradio'
                                    aria-checked={currentSpeed === speed}
                                    disabled={disabled}
                                    className='chat-composer-model-option chat-composer-codex-speed-option'
                                    onClick={() => {
                                        onChange?.(
                                            withCodexSpeed(
                                                draft,
                                                speed as CodexSpeed
                                            )
                                        )
                                        onRequestClose?.()
                                    }}
                                >
                                    <span className='min-w-0 flex-1'>
                                        <span className='chat-composer-codex-speed-name'>
                                            {speed === 'fast' && (
                                                <ZapIcon className='mr-1.5 inline h-4 w-4 align-middle' />
                                            )}
                                            {formatCodexSpeedLabel(speed, t)}
                                        </span>
                                        <span className='chat-composer-codex-speed-description'>
                                            {speed === 'fast'
                                                ? t('web.composer.fastDescription')
                                                : t('web.composer.standardSpeedDescription')}
                                        </span>
                                    </span>
                                    {currentSpeed === speed && (
                                        <CheckIcon className='chat-composer-menu-check h-4 w-4' />
                                    )}
                                </button>
                            </ShortcutTooltip>
                        )
                    })}
                </SubmenuPanel>
            )}
        </div>
    )
}

const GeminiModelConfigMenu: FC<{
    view: AgentModelConfigView
    draft: Extract<AgentModelConfig, { framework: 'gemini-cli' }> | null
    onChange?: (config: AgentModelConfig) => void
    onRequestClose?: () => void
}> = ({ view, draft, onChange, onRequestClose }): ReactNode => {
    const { t } = useI18n()
    const [submenu, setSubmenu] = useState<'model' | null>(null)
    const options = view.options
    const selectedModel = options.find(
        (option) => option.value === draft?.model
    )
    return (
        <div className='chat-composer-claude-menu'>
            <button
                type='button'
                className='chat-composer-model-option'
                onClick={() =>
                    setSubmenu((current) =>
                        current === 'model' ? null : 'model'
                    )
                }
            >
                <span className='chat-composer-codex-branch-copy'>
                    <span className='chat-composer-codex-branch-label'>
                        {t('web.composer.model')}
                    </span>
                    <span className='chat-composer-codex-branch-value'>
                        {selectedModel
                            ? selectedModel.label
                            : t('web.composer.chooseModel')}
                    </span>
                </span>
                <ChevronRightIcon className='text-muted h-4 w-4 shrink-0' />
            </button>
            {submenu === 'model' && (
                <SubmenuPanel
                    title={t('web.composer.models')}
                    count={options.length}
                >
                    {options.map((option) => {
                        const active = draft?.model === option.value
                        return (
                            <ShortcutTooltip
                                key={option.value}
                                label={option.reason ?? undefined}
                                className='w-full'
                            >
                                <button
                                    type='button'
                                    role='menuitemradio'
                                    aria-checked={active}
                                    disabled={!option.enabled}
                                    className='chat-composer-model-option'
                                    onClick={() => {
                                        onChange?.(
                                            withGeminiModel(draft, option.value)
                                        )
                                        onRequestClose?.()
                                    }}
                                >
                                    <span className='chat-composer-model-option-copy'>
                                        <span className='chat-composer-model-option-title'>
                                            {option.label}
                                        </span>
                                        {!option.enabled && option.reason && (
                                            <span className='chat-composer-model-option-detail'>
                                                {option.reason}
                                            </span>
                                        )}
                                    </span>
                                    {active && (
                                        <CheckIcon className='chat-composer-menu-check ml-auto h-4 w-4' />
                                    )}
                                </button>
                            </ShortcutTooltip>
                        )
                    })}
                </SubmenuPanel>
            )}
        </div>
    )
}

const SubmenuPanel: FC<{
    title: string
    count?: number
    children: ReactNode
}> = ({ title, count, children }): ReactNode => {
    const { t } = useI18n()
    return (
        <div className='popover-panel chat-composer-model-submenu' role='menu'>
            <div className='chat-composer-model-section-heading'>
                <span className='min-w-0 flex-1 truncate'>{title}</span>
                {count !== undefined && (
                    <span className='chat-composer-model-section-count'>
                        {t('web.composer.modelOptions', { count })}
                    </span>
                )}
            </div>
            {children}
        </div>
    )
}

const ModelMenuItem: FC<ModelMenuItemProps> = ({
    label,
    active,
    onSelect
}): ReactNode => (
    <button
        type='button'
        role='menuitemradio'
        aria-checked={active}
        className='chat-composer-model-option'
        onClick={onSelect}
    >
        <span className='min-w-0 truncate'>{label}</span>
        {active && (
            <CheckIcon className='chat-composer-menu-check ml-auto h-3.5 w-3.5' />
        )}
    </button>
)

const formatFrameworkLabel = (
    framework: AgentFramework | undefined,
    fallback: string
): string => {
    switch (framework) {
        case 'claude-code':
            return 'Claude Code'
        case 'codex':
            return 'Codex'
        case 'gemini-cli':
            return 'Gemini CLI'
        case 'openclaw':
            return 'OpenClaw'
        case 'hermes':
            return 'Hermes'
        case 'narranexus':
            return 'NarraNexus'
        default:
            // Generic fallback — translated callers should never need this for
            // a real framework. Keep English for log clarity.
            return fallback
    }
}

const formatStatusLabel = (status: AgentStatus, t: TFn): string => {
    switch (status) {
        case 'pending':
            return t('web.chat.agentStatus.pending')
        case 'running':
            return t('web.chat.agentStatus.running')
        case 'stopped':
            return t('web.chat.agentStatus.stopped')
        case 'failed':
            return t('web.chat.agentStatus.failed')
        default:
            return t('web.chat.agentStatus.unknown')
    }
}

const FrameworkLogoIcon: FC<{
    framework?: AgentFramework
    className?: string
}> = ({ framework, className }): ReactNode => {
    if (framework) {
        return (
            <FrameworkLogo
                framework={framework}
                size={16}
                className={className ?? ''}
            />
        )
    }

    return (
        <span
            className={[
                'shadow-ring-light bg-icon-bg text-icon-fg inline-flex shrink-0 items-center justify-center rounded-md',
                className ?? ''
            ].join(' ')}
            aria-hidden='true'
        >
            <FrameworkGlyph className='h-3 w-3' />
        </span>
    )
}

const FrameworkGlyph: FC<{ className?: string }> = ({
    className
}): ReactNode => (
    <svg
        viewBox='0 0 16 16'
        fill='none'
        stroke='currentColor'
        className={className}
    >
        <circle cx='4.25' cy='8' r='1.4' />
        <circle cx='11.75' cy='4.25' r='1.4' />
        <circle cx='11.75' cy='11.75' r='1.4' />
        <path
            d='M5.55 7.25 10.4 4.95M5.55 8.75l4.85 2.3M11.75 5.65v4.7'
            strokeLinecap='round'
            strokeWidth='1.3'
        />
    </svg>
)

const createAttachmentId = (): string =>
    globalThis.crypto?.randomUUID?.() ??
    `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`

const revokeAttachmentUrls = (attachments: PendingAttachment[]): void => {
    for (const attachment of attachments) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
    }
}

const uniqueModels = (models: string[]): string[] => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const model of models) {
        const trimmed = model.trim()
        if (!trimmed || seen.has(trimmed)) continue
        seen.add(trimmed)
        out.push(trimmed)
    }
    return out
}

const formatModelLabel = (model: string): string => {
    if (/^gpt-/i.test(model)) return model.replace(/^gpt/i, 'GPT')
    if (/^gemini-/i.test(model)) return model.replace(/^gemini/i, 'Gemini')
    return model
}

const titleCase = (value: string): string =>
    value.slice(0, 1).toUpperCase() + value.slice(1)

interface ComposerLabelParts {
    name: string
    detail: string | null
}

const formatCodexComposerLabel = (
    draft: AgentModelConfig | null,
    fallback: string,
    t: TFn
): ComposerLabelParts => {
    if (draft?.framework !== 'codex' || !draft.model)
        return { name: formatModelLabel(fallback), detail: null }
    return {
        name: formatCodexShortModelLabel(draft.model),
        detail: draft.intelligence
            ? formatCodexIntelligenceLabel(draft.intelligence, t)
            : null
    }
}

const formatGeminiComposerLabel = (
    draft: AgentModelConfig | null,
    fallback: string
): ComposerLabelParts => {
    if (draft?.framework !== 'gemini-cli' || !draft.model)
        return { name: formatModelLabel(fallback), detail: null }
    return { name: formatModelLabel(draft.model), detail: null }
}

const formatClaudeComposerLabel = (
    draft: AgentModelConfig | null,
    fallback: string,
    t: TFn
): ComposerLabelParts => {
    if (draft?.framework !== 'claude-code' || !draft.model)
        return { name: formatModelLabel(fallback), detail: null }
    const normalized = normalizeClaudeModelConfigDraft(draft)
    const selected = normalized.model
    const providerModel =
        selected && isClaudeCodeModelAlias(selected)
            ? normalized.modelMap?.[
                  claudeCodeModelAliasMapKey(selected)
              ]?.trim()
            : selected
    const modelLabel = formatClaudeProviderModelLabel(
        providerModel,
        selected && isClaudeCodeModelAlias(selected) ? selected : undefined
    )
    return {
        name: modelLabel,
        detail: normalized.effort
            ? formatClaudeEffortLabel(normalized.effort, t)
            : null
    }
}

const joinComposerLabelParts = (parts: ComposerLabelParts): string =>
    [parts.name, parts.detail].filter(Boolean).join(' · ')

const formatClaudeProviderModelLabel = (
    model: string | null | undefined,
    alias?: string
): string => {
    const family = claudeModelFamily(model, alias)
    const version = model ? claudeModelVersion(model) : null
    const context =
        alias && isClaudeCodeOneMillionModelAlias(alias) ? ' 1M' : ''
    return version ? `${family} ${version}${context}` : `${family}${context}`
}

const claudeModelFamily = (
    model: string | null | undefined,
    alias?: string
): string => {
    const normalized = model?.toLowerCase() ?? ''
    if (normalized.includes('opus')) return 'Opus'
    if (normalized.includes('sonnet')) return 'Sonnet'
    if (normalized.includes('haiku')) return 'Haiku'
    if (alias && isClaudeCodeModelAlias(alias))
        return titleCase(claudeCodeModelAliasMapKey(alias))
    return 'Claude'
}

const claudeModelVersion = (model: string): string | null => {
    const withoutDates = model.toLowerCase().replace(/\d{8}/g, ' ')
    const numbers = [...withoutDates.matchAll(/\d+/g)]
        .map((match) => Number(match[0]))
        .filter((value) => value > 0 && value < 100)
    if (numbers.length >= 2) return `${numbers[0]}.${numbers[1]}`
    if (numbers.length === 1) return String(numbers[0])
    return null
}

const formatCodexModelLabel = (model: string): string => {
    switch (codexCanonicalModelId(model)) {
        case 'gpt-5.6-sol':
            return 'GPT-5.6 Sol'
        case 'gpt-5.6-terra':
            return 'GPT-5.6 Terra'
        case 'gpt-5.6-luna':
            return 'GPT-5.6 Luna'
        case 'gpt-5.5':
            return 'GPT-5.5'
        case 'gpt-5.4':
            return 'GPT-5.4'
        case 'gpt-5.4-mini':
            return 'GPT-5.4-Mini'
        case 'gpt-5.3-codex-spark':
            return 'GPT-5.3-Codex-Spark'
        case 'gpt-5.3-codex':
            return 'GPT-5.3-Codex'
        case 'gpt-5.2':
            return 'GPT-5.2'
        default:
            return formatModelLabel(model)
    }
}

const formatCodexShortModelLabel = (model: string): string => {
    switch (codexCanonicalModelId(model)) {
        case 'gpt-5.6-sol':
            return '5.6 Sol'
        case 'gpt-5.6-terra':
            return '5.6 Terra'
        case 'gpt-5.6-luna':
            return '5.6 Luna'
        case 'gpt-5.5':
            return '5.5'
        case 'gpt-5.4':
            return '5.4'
        case 'gpt-5.4-mini':
            return '5.4 Mini'
        case 'gpt-5.3-codex-spark':
            return '5.3 Spark'
        case 'gpt-5.3-codex':
            return '5.3 Codex'
        case 'gpt-5.2':
            return '5.2'
        default:
            return formatCodexModelLabel(model).replace(/^GPT-/, '')
    }
}

const formatCodexProviderModelDetail = (model: string): string | null =>
    /[/:]/.test(model) ? model : null

const formatSize = (size: number): string => {
    if (size < 1024) return `${size} B`
    const kb = size / 1024
    if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`
    const mb = kb / 1024
    return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`
}

const readDraft = (key: string | null): string => {
    if (!key) return ''
    try {
        return window.localStorage.getItem(key) ?? ''
    } catch {
        return ''
    }
}

const writeDraft = (key: string | null, value: string): void => {
    if (!key) return
    try {
        if (value) {
            window.localStorage.setItem(key, value)
        } else {
            window.localStorage.removeItem(key)
        }
    } catch {
        /* ignore local storage failures */
    }
}

const clearDraft = (key: string | null): void => {
    if (!key) return
    try {
        window.localStorage.removeItem(key)
    } catch {
        /* ignore local storage failures */
    }
}

export default Composer
