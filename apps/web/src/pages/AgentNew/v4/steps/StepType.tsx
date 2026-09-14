import type { FC, ReactNode } from 'react'
import type { AgentFramework } from '@manyfold/shared'
import { useI18n } from '@/lib/i18n'
import {
    OptionGroup,
    OptionRow
} from '@/pages/AgentNew/v4/components/OptionRow'
import { FRAMEWORK_GROUPS } from '@/pages/AgentNew/v4/frameworkCatalog'

// Step ①. All nine types, always, in two groups.
//
// The groups name where the thing runs, which is the one difference that is
// binary and has no exceptions — and it is also where step ② forks, so the
// heading is a preview of the next question rather than a verdict on the tool.
// Ability wording stays out of headings AND row lines: the nine overlap far too
// much for "writes code" versus "assistant" to be true of any of them
// exclusively.
export const StepType: FC<{
    value: AgentFramework | null
    onChange: (framework: AgentFramework) => void
}> = ({ value, onChange }): ReactNode => {
    const { t } = useI18n()
    return (
        <>
            {FRAMEWORK_GROUPS.map((group) => (
                <OptionGroup key={group.id} title={t(group.titleKey)}>
                    {group.entries.map((entry) => (
                        <OptionRow
                            key={entry.framework}
                            title={entry.label}
                            detail={t(entry.identityKey)}
                            meta={
                                entry.subscriptionKey !== undefined
                                    ? t(entry.subscriptionKey)
                                    : undefined
                            }
                            Mark={entry.Mark}
                            Icon={entry.FallbackIcon}
                            selected={value === entry.framework}
                            onSelect={() => onChange(entry.framework)}
                        />
                    ))}
                </OptionGroup>
            ))}
        </>
    )
}
