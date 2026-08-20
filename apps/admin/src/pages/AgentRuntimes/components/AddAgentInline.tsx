import {
    AgentFramework,
    AgentSummary,
    normalizeAgentName,
    validateAgentName
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import { t } from '@manyfold/i18n'
import { Button, Card, CardBody, Heading, Input } from '@/ui'

interface Props {
    framework: AgentFramework
    siblingInternalIds: string[]
    onAdd: (body: {
        name: string
        workspace?: string
        model?: string
        cloneFrom?: string
    }) => Promise<AgentSummary>
}

const AddAgentInline: FC<Props> = ({
    framework,
    siblingInternalIds,
    onAdd
}): ReactNode => {
    const [expanded, setExpanded] = useState(false)
    const [name, setName] = useState('')
    const [workspace, setWorkspace] = useState('')
    const [model, setModel] = useState('')
    const [cloneFrom, setCloneFrom] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const nameValidation = validateAgentName(name)
    const normalizedName = nameValidation.valid
        ? nameValidation.value
        : normalizeAgentName(name)
    const nameValidationMessage =
        nameValidation.valid || name.length === 0
            ? null
            : nameValidation.message

    const reset = (): void => {
        setName('')
        setWorkspace('')
        setModel('')
        setCloneFrom('')
        setError(null)
        setSubmitting(false)
    }

    const collapse = (): void => {
        reset()
        setExpanded(false)
    }

    const handleSubmit = async (): Promise<void> => {
        if (!nameValidation.valid) return
        setSubmitting(true)
        setError(null)
        try {
            await onAdd({
                name: normalizedName,
                workspace: workspace.trim() || undefined,
                model: model.trim() || undefined,
                cloneFrom: cloneFrom.trim() || undefined
            })
            collapse()
        } catch (e) {
            setError((e as Error).message)
            setSubmitting(false)
        }
    }

    if (!expanded)
        return (
            <Button
                variant='neutral'
                size='sm'
                onClick={(): void => setExpanded(true)}
            >
                + {t('admin.agentRuntimes.detail.actions.addAgent')}
            </Button>
        )

    return (
        <Card elevation='elevated'>
            <CardBody>
                <Heading level={3} className='mb-3'>
                    {t('admin.agentRuntimes.detail.addAgent.title')}
                </Heading>
                <div className='grid grid-cols-1 gap-3 md:grid-cols-2'>
                    <Input
                        id='add-agent-name'
                        label={t(
                            'admin.agentRuntimes.detail.addAgent.nameLabel'
                        )}
                        placeholder={t(
                            'admin.agentRuntimes.detail.addAgent.namePlaceholder'
                        )}
                        value={name}
                        onChange={(e): void => setName(e.target.value)}
                        disabled={submitting}
                    />
                    {framework === 'openclaw' && (
                        <>
                            <Input
                                id='add-agent-workspace'
                                label={t(
                                    'admin.agentRuntimes.detail.addAgent.workspaceLabel'
                                )}
                                placeholder={t(
                                    'admin.agentRuntimes.detail.addAgent.workspacePlaceholder'
                                )}
                                value={workspace}
                                onChange={(e): void =>
                                    setWorkspace(e.target.value)
                                }
                                disabled={submitting}
                            />
                            <Input
                                id='add-agent-model'
                                label={t(
                                    'admin.agentRuntimes.detail.addAgent.modelLabel'
                                )}
                                placeholder={t(
                                    'admin.agentRuntimes.detail.addAgent.modelPlaceholder'
                                )}
                                value={model}
                                onChange={(e): void => setModel(e.target.value)}
                                disabled={submitting}
                            />
                        </>
                    )}
                    {framework === 'hermes' && (
                        <div>
                            <label
                                htmlFor='add-agent-clone-from'
                                className='text-caption text-label mb-1 block font-normal'
                            >
                                {t(
                                    'admin.agentRuntimes.detail.addAgent.cloneFromLabel'
                                )}
                            </label>
                            <select
                                id='add-agent-clone-from'
                                className='border-border text-body text-heading focus:border-brand focus:ring-brand block h-10 w-full rounded border bg-white px-3 transition-colors focus:ring-1 focus:outline-none'
                                value={cloneFrom}
                                onChange={(e): void =>
                                    setCloneFrom(e.target.value)
                                }
                                disabled={submitting}
                            >
                                <option value=''>
                                    {t(
                                        'admin.agentRuntimes.detail.addAgent.cloneFromNone'
                                    )}
                                </option>
                                {siblingInternalIds.map((sid) => (
                                    <option key={sid} value={sid}>
                                        {sid}
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}
                </div>
                {nameValidationMessage && (
                    <pre className='text-caption-sm text-accent-ruby mt-3 whitespace-pre-wrap'>
                        {nameValidationMessage}
                    </pre>
                )}
                {error && (
                    <pre className='text-caption-sm text-accent-ruby mt-3 whitespace-pre-wrap'>
                        {error}
                    </pre>
                )}
                <div className='mt-2 flex gap-2'>
                    <Button
                        variant='primary'
                        size='sm'
                        disabled={!nameValidation.valid || submitting}
                        onClick={(): void => {
                            void handleSubmit()
                        }}
                    >
                        {submitting
                            ? t(
                                  'admin.agentRuntimes.detail.addAgent.submitting'
                              )
                            : t('admin.agentRuntimes.detail.addAgent.submit')}
                    </Button>
                    <Button
                        variant='neutral'
                        size='sm'
                        onClick={collapse}
                        disabled={submitting}
                    >
                        {t('admin.agentRuntimes.detail.addAgent.cancel')}
                    </Button>
                </div>
            </CardBody>
        </Card>
    )
}

export default AddAgentInline
