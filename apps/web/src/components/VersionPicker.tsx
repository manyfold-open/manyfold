import type { FC, ReactNode, RefObject } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Spinner } from '@/components/Loading'
import { VersionTag } from '@/components/VersionTag'
import { CheckIcon } from '@/components/icons'
import { useAnchoredMenuPosition } from '@/hooks/useAnchoredMenuPosition'
import { useI18n } from '@/lib/i18n'
import type { UpdateKind } from '@/lib/updateCenter'

export interface VersionChoiceGroup {
    // Shown above the group when there is more than one.
    label: string | null
    versions: readonly string[]
}

const VersionMenu: FC<{
    anchorRef: RefObject<HTMLButtonElement>
    current: string | null
    groups: VersionChoiceGroup[]
    latest: string | null
    onPick: (version: string) => void
    onClose: () => void
}> = ({ anchorRef, current, groups, latest, onPick, onClose }): ReactNode => {
    const { t } = useI18n()
    const menuRef = useRef<HTMLDivElement>(null)
    const style = useAnchoredMenuPosition(true, anchorRef, menuRef, {
        align: 'start',
        matchAnchorWidth: false
    })
    useEffect(() => {
        const onDown = (event: PointerEvent): void => {
            const target = event.target as Node
            if (
                !anchorRef.current?.contains(target) &&
                !menuRef.current?.contains(target)
            )
                onClose()
        }
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') return
            onClose()
            anchorRef.current?.focus()
        }
        document.addEventListener('pointerdown', onDown)
        window.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('pointerdown', onDown)
            window.removeEventListener('keydown', onKey)
        }
    }, [anchorRef, onClose])
    const titled = groups.length > 1
    return createPortal(
        <div
            ref={menuRef}
            role='menu'
            aria-label={t('web.runtimeDetails.changeVersion')}
            className={[
                'popover-panel bg-surface-elevated shadow-elevated fixed z-[110] w-60 overflow-auto rounded-md p-1',
                style ? '' : 'invisible'
            ].join(' ')}
            style={style}
        >
            <div className='text-caption text-subtle px-2.5 py-1.5'>
                {t('web.runtimeDetails.changeVersion')}
            </div>
            {groups.map((group) => (
                <div
                    key={group.label ?? ''}
                    role='group'
                    aria-label={group.label ?? undefined}
                >
                    {titled && group.label && (
                        <div className='text-caption text-subtle px-2.5 pb-1 pt-2'>
                            {group.label}
                        </div>
                    )}
                    {group.versions.map((version) => {
                        const installed = version === current
                        return (
                            <button
                                key={version}
                                type='button'
                                role='menuitemradio'
                                aria-checked={installed}
                                disabled={installed}
                                onClick={() => onPick(version)}
                                className='text-ui hover:bg-soft flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left transition-colors disabled:cursor-default disabled:hover:bg-transparent'
                            >
                                <span className='text-fg min-w-0 flex-1 truncate font-mono'>
                                    {version}
                                </span>
                                {version === latest && (
                                    <span className='text-caption text-subtle shrink-0'>
                                        {t('web.agentRuntimesList.latest')}
                                    </span>
                                )}
                                <CheckIcon
                                    aria-hidden='true'
                                    className={[
                                        'h-3.5 w-3.5 shrink-0',
                                        installed ? 'text-fg' : 'invisible'
                                    ].join(' ')}
                                />
                            </button>
                        )
                    })}
                </div>
            ))}
        </div>,
        document.body
    )
}

// The product's one version control: the installed version as a pill whose
// arrow, when something newer is out, leads to the Update Center, and whose
// version opens a list to move to another one. Picking is the whole action.
// A version with nothing else to pick is a plain pill.
const VersionPicker: FC<{
    current: string | null
    // What the pill says with no version reported.
    unknownLabel: string
    groups: VersionChoiceGroup[]
    latest: string | null
    // The newer version the Update Center has a row for, or null.
    update: string | null
    kind: UpdateKind
    busy: boolean
    busyLabel: string
    // null = the version cannot be changed from here.
    onPick: ((version: string) => void) | null
}> = ({
    current,
    unknownLabel,
    groups,
    latest,
    update,
    kind,
    busy,
    busyLabel,
    onPick
}): ReactNode => {
    const { t } = useI18n()
    const [open, setOpen] = useState(false)
    const anchorRef = useRef<HTMLButtonElement>(null)
    if (busy)
        return (
            <span className='text-caption text-muted inline-flex items-center gap-1.5'>
                <Spinner size={12} />
                {busyLabel}
            </span>
        )
    const choices = groups.filter((group) => group.versions.length > 0)
    const pickable =
        onPick !== null &&
        choices.some((group) => group.versions.some((v) => v !== current))
    return (
        <>
            <VersionTag
                label={current ?? unknownLabel}
                mono={current !== null}
                latest={update}
                kind={kind}
                prefix=''
                labelPress={
                    pickable
                        ? {
                              onPress: () => setOpen((prev) => !prev),
                              expanded: open,
                              ariaLabel: t('web.runtimeDetails.changeVersion'),
                              anchorRef
                          }
                        : undefined
                }
            />
            {open && onPick && (
                <VersionMenu
                    anchorRef={anchorRef}
                    current={current}
                    groups={choices}
                    latest={latest}
                    onPick={(version) => {
                        setOpen(false)
                        onPick(version)
                    }}
                    onClose={() => setOpen(false)}
                />
            )}
        </>
    )
}

export default VersionPicker
