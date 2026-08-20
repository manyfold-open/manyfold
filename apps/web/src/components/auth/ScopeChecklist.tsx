import {
    GrantableScope,
    ScopeMetadata,
    scopeMetadata
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { RiskTag } from '@/components/Tag'
import { useI18n } from '@/lib/i18n'

interface ScopeChecklistProps {
    requestedScopes: GrantableScope[]
    selectedScopes: GrantableScope[]
    onToggle: (scope: GrantableScope, next: boolean) => void
    disabled?: boolean
}

export const ScopeChecklist: FC<ScopeChecklistProps> = ({
    requestedScopes,
    selectedScopes,
    onToggle,
    disabled
}): ReactNode => {
    const { t } = useI18n()
    const requested = new Set<GrantableScope>(requestedScopes)
    const selected = new Set<GrantableScope>(selectedScopes)
    const ordered = requestedScopeMetadata(requestedScopes)

    return (
        <ul className='space-y-2'>
            {ordered.map((meta) => {
                const isRequested = requested.has(meta.scope)
                const isSelected = selected.has(meta.scope)
                const isHigh = meta.danger === 'high'
                return (
                    <li
                        key={meta.scope}
                        className={[
                            'border-divider bg-surface rounded-md border px-3.5 py-3 transition-shadow',
                            isHigh && isSelected
                                ? 'ring-workflow-ship/40 ring-2'
                                : '',
                            !isRequested ? 'opacity-50' : ''
                        ]
                            .filter(Boolean)
                            .join(' ')}
                    >
                        <label className='flex cursor-pointer items-start gap-3'>
                            <input
                                type='checkbox'
                                className='border-divider text-fg focus-visible:ring-focus mt-0.5 h-4 w-4 rounded'
                                checked={isSelected}
                                disabled={disabled || !isRequested}
                                onChange={(event) =>
                                    onToggle(meta.scope, event.target.checked)
                                }
                                aria-describedby={`scope-${meta.scope}-summary`}
                            />
                            <span className='min-w-0 flex-1'>
                                <span className='flex flex-wrap items-center gap-2'>
                                    <code className='text-ui text-fg font-mono'>
                                        {meta.scope}
                                    </code>
                                    <RiskTag danger={meta.danger} />
                                    {!isRequested && (
                                        <span className='text-caption text-placeholder'>
                                            {t('web.permissions.notRequested')}
                                        </span>
                                    )}
                                </span>
                                <span
                                    id={`scope-${meta.scope}-summary`}
                                    className='text-ui text-muted mt-1 block'
                                >
                                    {meta.summary}
                                </span>
                            </span>
                        </label>
                    </li>
                )
            })}
        </ul>
    )
}

export const requestedScopeMetadata = (
    requestedScopes: GrantableScope[]
): readonly ScopeMetadata[] => {
    const requestedSet = new Set<GrantableScope>(requestedScopes)
    const requested = scopeMetadata.filter((m) => requestedSet.has(m.scope))
    return requested
}
