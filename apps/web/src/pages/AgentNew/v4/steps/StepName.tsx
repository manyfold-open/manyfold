import type { FC, ReactNode } from 'react'
import type { AgentFramework } from '@manyfold/shared'
import { useI18n } from '@/lib/i18n'
import { workspaceValidationMessage } from '@/lib/agentCreateDraft'
import type { CreateStepId } from '@/pages/AgentNew/v4/flowState'
import { hasWorkspace } from '@/pages/AgentNew/v4/frameworkCatalog'

interface SummaryLine {
    step: CreateStepId
    label: string
    value: string
}

// The full record of what was chosen — the long form of what the step bar
// shows short (decision T). It sits BELOW the fields, not above them: this
// step's own work is the name and the directory, and putting a recap of three
// settled decisions between the question and the first input made the reader
// cross what they had already decided to reach what they had not. Being last
// also puts it where decision T wanted it — next to the button, because the
// final look should not be the thing furthest from the action.
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
    framework: AgentFramework
    typeLabel: string
    whereLabel: string
    costLabel: string
    name: string
    onChangeName: (value: string) => void
    // Whether the path names a disk the user themselves can see. It changes
    // what the field means, not whether it exists: on a sandbox or a cloud
    // computer the platform allocates one when this is left empty, and on the
    // user's own machine it falls back to ~/.manyfold/workspaces/.
    ownComputer: boolean
    workspace: string
    onChangeWorkspace: (value: string) => void
    onJump: (step: CreateStepId) => void
}> = ({
    framework,
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
    const workspaceError = workspaceValidationMessage(workspace)
    return (
        <>
            <div className='px-3'>
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
            {hasWorkspace(framework) && (
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
                        aria-invalid={workspaceError !== null}
                        placeholder={
                            ownComputer
                                ? t('web.agentNewV4.name.workspacePlaceholder')
                                : t(
                                      'web.agentNewV4.name.workspacePlaceholderManaged'
                                  )
                        }
                        onChange={(event) =>
                            onChangeWorkspace(event.target.value)
                        }
                    />
                    <p className='workbench-hint mt-1.5'>
                        {ownComputer
                            ? t('web.agentNewV4.name.workspaceHint')
                            : t('web.agentNewV4.name.workspaceManaged')}
                    </p>
                </div>
            )}
            <p className='text-caption text-subtle mt-7 px-3'>
                {t('web.agentNewV4.name.chosen')}
            </p>
            <div className='mt-1.5'>
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
            </div>
        </>
    )
}
