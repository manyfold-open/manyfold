import type { FC, ReactNode } from 'react'
import { useRef } from 'react'

// The default workspace path carries placeholder tokens the backend fills in
// at create time (`{agent-id}`, and `<mf-user>` for narranexus). Rendering them
// as literal editable text made users think they had to hand-replace the token
// or that the field was broken. We keep the whole path editable, but paint the
// token segments in a quiet "will be generated" hint style so they read as
// system placeholders rather than values the user typed.
const WORKSPACE_TOKEN_RE = /(\{agent-id\}|<mf-user>)/g
const WORKSPACE_TOKENS = new Set(['{agent-id}', '<mf-user>'])

const renderSegments = (value: string): ReactNode =>
    value.split(WORKSPACE_TOKEN_RE).map((part, i) =>
        WORKSPACE_TOKENS.has(part) ? (
            <span key={i} className='text-subtle italic'>
                {part}
            </span>
        ) : (
            <span key={i}>{part}</span>
        )
    )

type WorkspacePathFieldVariant = 'inline' | 'field'

// The transparent input has no visible edge, so its wrapper preserves the
// browser's element-specific `:focus-visible` decision (DESIGN.md §8.9).
const VARIANT_WRAPPER: Record<WorkspacePathFieldVariant, string> = {
    inline: 'relative grid min-w-0 flex-1',
    field: 'shadow-ring-light has-[:focus-visible]:shadow-focus bg-surface relative grid h-10 w-full overflow-hidden rounded-sm px-3.5 transition-shadow'
}

const VARIANT_TEXT: Record<WorkspacePathFieldVariant, string> = {
    inline: 'font-mono text-caption whitespace-pre',
    field: 'font-mono text-ui whitespace-pre'
}

interface WorkspacePathFieldProps {
    value: string
    onChange: (value: string) => void
    variant: WorkspacePathFieldVariant
    ariaLabel: string
    maxLength?: number
}

export const WorkspacePathField: FC<WorkspacePathFieldProps> = ({
    value,
    onChange,
    variant,
    ariaLabel,
    maxLength = 1024
}): ReactNode => {
    const overlayRef = useRef<HTMLDivElement>(null)
    const syncScroll = (input: HTMLInputElement): void => {
        if (overlayRef.current)
            overlayRef.current.scrollLeft = input.scrollLeft
    }
    const text = VARIANT_TEXT[variant]
    return (
        <div className={VARIANT_WRAPPER[variant]}>
            <div
                ref={overlayRef}
                aria-hidden='true'
                className={`${text} text-fg pointer-events-none col-start-1 row-start-1 flex items-center overflow-hidden`}
            >
                {renderSegments(value)}
            </div>
            <input
                value={value}
                onChange={(e) => {
                    onChange(e.target.value)
                    syncScroll(e.target)
                }}
                onScroll={(e) => syncScroll(e.currentTarget)}
                spellCheck={false}
                aria-label={ariaLabel}
                style={{ caretColor: 'rgb(var(--color-fg))' }}
                className={`${text} col-start-1 row-start-1 h-full w-full bg-transparent text-transparent focus:outline-none`}
                maxLength={maxLength}
            />
        </div>
    )
}
