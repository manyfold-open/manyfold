import type { FC, ReactNode } from 'react'
import { useI18n } from '@/lib/i18n'
import type { CreateStepId } from '@/pages/AgentNew/v4/flowState'

interface SummaryLine {
    step: CreateStepId
    label: string
    value: string
}

// The full record of what was chosen lives here, not in the path bar. A line
// each, with its own way back — which the path bar could never afford, because
// its width is fixed and it has to stay readable at a glance. It is only
// needed in the moment before committing anyway.
//
// Per DESIGN.md §8.12 a read-only summary is a label:value footnote, not a
// filled card: a fill would make these rows look pressable when only the
// Change link is.
const Summary: FC<{
    lines: SummaryLine[]
    onJump: (step: CreateStepId) => void
}> = ({ lines, onJump }): ReactNode => {
    const { t } = useI18n()
    return (
        <dl className='divide-divider divide-y'>
            {lines.map((line) => (
                <div
                    key={line.step + line.label}
                    className='flex items-baseline gap-3 px-3 py-2.5'
                >
                    <dt className='text-caption text-placeholder w-20 shrink-0'>
                        {line.label}
                    </dt>
                    <dd className='text-ui text-fg min-w-0 flex-1 break-words'>
                        {line.value}
                    </dd>
                    <button
                        type='button'
                        className='text-caption text-link shrink-0 underline-offset-2 hover:underline'
                        onClick={() => onJump(line.step)}
                    >
                        {t('web.agentNewV4.change')}
                    </button>
                </div>
            ))}
        </dl>
    )
}

export const StepName: FC<{
    typeLabel: string
    whereLabel: string
    costLabel: string
    name: string
    onChangeName: (value: string) => void
    // A workspace is only a real question on the user's own computer, where it
    // names a real path on a real disk they care about. On a sandbox or a
    // cloud computer the platform allocates one, so it is a sentence, not a
    // field.
    ownComputer: boolean
    workspace: string
    onChangeWorkspace: (value: string) => void
    onJump: (step: CreateStepId) => void
}> = ({
    typeLabel,
    whereLabel,
    costLabel,
    name,
    onChangeName,
    ownComputer,
    workspace,
    onChangeWorkspace,
    onJump
}): ReactNode => {
    const { t } = useI18n()
    return (
        <>
            <Summary
                lines={[
                    {
                        step: 'type',
                        label: t('web.agentNewV4.step.type'),
                        value: typeLabel
                    },
                    {
                        step: 'runtime',
                        label: t('web.agentNewV4.step.runtime'),
                        value: whereLabel
                    },
                    {
                        step: 'cost',
                        label: t('web.agentNewV4.step.cost'),
                        value: costLabel
                    }
                ]}
                onJump={onJump}
            />
            <div className='mt-6 px-3'>
                <label className='workbench-field-label' htmlFor='v4-name'>
                    {t('web.agentNewV4.name.label')}
                </label>
                <input
                    id='v4-name'
                    className='workbench-input'
                    value={name}
                    onChange={(event) => onChangeName(event.target.value)}
                />
            </div>
            {ownComputer ? (
                <div className='mt-5 px-3'>
                    <label
                        className='workbench-field-label'
                        htmlFor='v4-workspace'
                    >
                        {t('web.agentNewV4.name.workspaceLabel')}
                    </label>
                    <input
                        id='v4-workspace'
                        className='workbench-input font-mono'
                        value={workspace}
                        placeholder='~/code/my-project'
                        onChange={(event) =>
                            onChangeWorkspace(event.target.value)
                        }
                    />
                    <p className='workbench-hint mt-1.5'>
                        {t('web.agentNewV4.name.workspaceHint')}
                    </p>
                </div>
            ) : (
                <p className='workbench-hint mt-5 px-3'>
                    {t('web.agentNewV4.name.workspaceManaged')}
                </p>
            )}
        </>
    )
}
