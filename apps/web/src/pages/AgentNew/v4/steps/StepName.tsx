import type { FC, ReactNode } from 'react'
import { useI18n } from '@/lib/i18n'
import { workspaceValidationMessage } from '@/lib/agentCreateDraft'
import type { CreateStepId } from '@/pages/AgentNew/v4/flowState'


interface SummaryLine {
    step: CreateStepId
    label: string
    value: string
}

// Nothing here carries horizontal padding of its own. This page aligns on
// INK, not on boxes: the question, the group labels and the option rows' icons
// on the three steps before this one all start at the same x, which is why
// `.create-option-row` hangs 12px outside the column — its own padding, paid
// back so its text lands on the line. A field is not that shape (its border is
// always visible, so it belongs ON the column rather than outside it), but
// wrapping these blocks in `px-3` pushed every label, hint and summary row 12px
// right of everything that led here, and the last screen read as narrower than
// the flow it finishes.
//
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
                    className='flex items-baseline gap-3 py-2.5'
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
    // The path the agent gets if this is left empty, resolved for the machine
    // that was picked. Null when there is no workspace to speak of — a
    // connected service has no machine, and hermes has no project directory.
    defaultWorkspace: string | null
    workspace: string
    onChangeWorkspace: (value: string) => void
    onJump: (step: CreateStepId) => void
}> = ({
    typeLabel,
    whereLabel,
    costLabel,
    name,
    onChangeName,
    defaultWorkspace,
    workspace,
    onChangeWorkspace,
    onJump
}): ReactNode => {
    const { t } = useI18n()
    const workspaceError = workspaceValidationMessage(workspace)
    return (
        <>
            <div>
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
            {defaultWorkspace !== null && (
                <div className='mt-5'>
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
                        placeholder={defaultWorkspace}
                        onChange={(event) =>
                            onChangeWorkspace(event.target.value)
                        }
                    />
                    <p className='workbench-hint mt-1.5'>
                        {t('web.agentNewV4.name.workspaceHint')}
                    </p>
                </div>
            )}
            <p className='text-caption text-subtle mt-7'>
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
