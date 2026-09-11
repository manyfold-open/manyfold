import {
    AgentModelConfig,
    AgentModelConfigView,
    CodexIntelligence,
    CodexSpeed,
    claudeCodeModelMapAliases
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon } from '@/components/icons'
import {
    claudeEffortOptionsForDraft,
    codexIntelligenceOptionsForModel,
    codexSpeedOptions,
    formatClaudeEffortLabel,
    normalizeClaudeModelConfigDraft
} from '@/lib/agentModelConfig'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { useI18n } from '@/lib/i18n'

interface Props {
    view: AgentModelConfigView | null
    draft: AgentModelConfig | null
    validationMessage: string | null
    onChange: (config: AgentModelConfig) => void
    // The "test first" affordance for surfaces whose provider rows carry no
    // refresh of their own; a form that tests from the row leaves these out
    // and renders nothing until the models are loaded.
    onTestProvider?: () => void
    providerTestLabel?: string
    providerTesting?: boolean
    providerTestDisabled?: boolean
    providerTestError?: string | null
}

// A folded group's header: the chevron, the group label and — while folded —
// the values it hides, so the section reads complete at a glance.
const GroupToggle: FC<{
    open: boolean
    onToggle: () => void
    label: string
    summary?: string | null
}> = ({ open, onToggle, label, summary }): ReactNode => {
    const Chevron = open ? ChevronDownIcon : ChevronRightIcon
    return (
        <button
            type='button'
            aria-expanded={open}
            onClick={onToggle}
            className='workbench-group-label focus-visible:shadow-focus inline-flex w-fit max-w-full items-center gap-1 rounded-sm transition-[color,box-shadow] focus:outline-none'
        >
            <Chevron className='h-3.5 w-3.5 shrink-0' aria-hidden='true' />
            <span className='truncate'>
                {label}
                {!open && summary ? (
                    <span className='text-subtle font-normal'>
                        {' · '}
                        {summary}
                    </span>
                ) : null}
            </span>
        </button>
    )
}

export const CreateFrameworkModelConfig: FC<Props> = ({
    view,
    draft,
    validationMessage,
    onChange,
    onTestProvider,
    providerTestLabel,
    providerTesting = false,
    providerTestDisabled = false,
    providerTestError = null
}): ReactNode => {
    const { t } = useI18n()
    // Both groups fold until asked for — the alias map as the detail behind
    // the default, the default itself with its value in the header — except
    // when a validation message points into them.
    const [mappingOpen, setMappingOpen] = useState(false)
    const [defaultOpen, setDefaultOpen] = useState(false)
    if (!view) return null
    if (view.providerModelsStatus !== 'ready') {
        if (!onTestProvider) return null
        return (
            <div className='workbench-note space-y-3'>
                <p>{t('web.agentNew.modelConfigTestHint')}</p>
                <button
                    type='button'
                    onClick={onTestProvider}
                    disabled={providerTesting || providerTestDisabled}
                    className='workbench-button-secondary h-9'
                >
                    {providerTesting
                        ? t('web.agentNew.testing')
                        : providerTestLabel}
                </button>
                {providerTestError && (
                    <div className='workbench-alert-error'>
                        {providerTestError}
                    </div>
                )}
            </div>
        )
    }
    if (view.framework === 'claude-code') {
        const existing = draft?.framework === 'claude-code' ? draft : null
        const currentDraft = existing
            ? normalizeClaudeModelConfigDraft(existing)
            : null
        const modelMap = currentDraft?.modelMap ?? {}
        const effortOptions = claudeEffortOptionsForDraft(currentDraft)
        const update = (
            patch: Partial<
                Extract<AgentModelConfig, { framework: 'claude-code' }>
            >
        ): void =>
            onChange(
                normalizeClaudeModelConfigDraft({
                    framework: 'claude-code',
                    model: currentDraft?.model ?? null,
                    effort: currentDraft?.effort ?? null,
                    modelMap,
                    ...patch
                })
            )
        const showMapping = mappingOpen || Boolean(validationMessage)
        const showDefault = defaultOpen || Boolean(validationMessage)
        const defaultSummary = [
            view.options.find((option) => option.value === currentDraft?.model)
                ?.label ?? currentDraft?.model,
            currentDraft?.effort
                ? formatClaudeEffortLabel(currentDraft.effort, t)
                : null
        ]
            .filter((part): part is string => Boolean(part))
            .join(' · ')
        return (
            <div className='grid gap-2'>
                <GroupToggle
                    open={showMapping}
                    onToggle={() => setMappingOpen((open) => !open)}
                    label={t('web.agentNew.claudeModelMapping')}
                />
                {showMapping && (
                    <div className='grid gap-2 md:grid-cols-2'>
                        {claudeCodeModelMapAliases.map((alias) => (
                            <div key={alias} className='block'>
                                <span className='text-caption text-subtle mb-1 block font-medium capitalize'>
                                    {alias}
                                </span>
                                <WorkbenchSelect
                                    mono
                                    size='sm'
                                    ariaLabel={alias}
                                    value={modelMap[alias] ?? ''}
                                    onChange={(next) =>
                                        update({
                                            ...(!currentDraft?.model && next
                                                ? { model: alias }
                                                : {}),
                                            modelMap: {
                                                ...modelMap,
                                                [alias]: next || undefined
                                            }
                                        })
                                    }
                                    options={[
                                        {
                                            value: '',
                                            label: t(
                                                'web.agentNew.selectProviderModel'
                                            )
                                        },
                                        ...view.providerModels.map((model) => ({
                                            value: model,
                                            label: model
                                        }))
                                    ]}
                                />
                            </div>
                        ))}
                    </div>
                )}
                <GroupToggle
                    open={showDefault}
                    onToggle={() => setDefaultOpen((open) => !open)}
                    label={
                        effortOptions.length > 0
                            ? t('web.agentNew.defaultModelAndEffort')
                            : t('web.agentNew.defaultModel')
                    }
                    summary={defaultSummary}
                />
                {showDefault && (
                    <div
                        className={
                            effortOptions.length > 0
                                ? 'grid gap-2 md:grid-cols-2'
                                : 'grid gap-2'
                        }
                    >
                        <div>
                            <span className='text-caption text-subtle mb-1 block font-medium'>
                                {t('web.agentNew.defaultModel')}
                            </span>
                            <WorkbenchSelect
                                size='sm'
                                ariaLabel={t('web.agentNew.defaultModel')}
                                placeholder={t('web.agentNew.selectModel')}
                                value={currentDraft?.model ?? ''}
                                onChange={(next) =>
                                    update({ model: next || null })
                                }
                                options={[
                                    {
                                        value: '',
                                        label: t('web.agentNew.selectModel')
                                    },
                                    ...view.options.map((option) => ({
                                        value: option.value,
                                        label: option.label,
                                        disabled: !option.enabled
                                    }))
                                ]}
                            />
                        </div>
                        {effortOptions.length > 0 && (
                            <div>
                                <span className='text-caption text-subtle mb-1 block font-medium'>
                                    {t('web.agentNew.effort')}
                                </span>
                                <WorkbenchSelect
                                    size='sm'
                                    ariaLabel={t('web.agentNew.effort')}
                                    value={currentDraft?.effort ?? ''}
                                    onChange={(next) =>
                                        update({
                                            effort: next as (typeof effortOptions)[number]
                                        })
                                    }
                                    options={effortOptions.map((effort) => ({
                                        value: effort,
                                        label: formatClaudeEffortLabel(
                                            effort,
                                            t
                                        )
                                    }))}
                                />
                            </div>
                        )}
                    </div>
                )}
                {validationMessage && (
                    <div className='workbench-alert-error'>
                        {validationMessage}
                    </div>
                )}
            </div>
        )
    }
    const codexDraft = draft?.framework === 'codex' ? draft : null
    const update = (
        patch: Partial<Extract<AgentModelConfig, { framework: 'codex' }>>
    ): void =>
        onChange({
            framework: 'codex',
            model: codexDraft?.model ?? null,
            speed: codexDraft?.speed ?? 'standard',
            intelligence: codexDraft?.intelligence ?? 'medium',
            ...patch
        })
    const showCodex = defaultOpen || Boolean(validationMessage)
    const codexSummary = [
        view.options.find((option) => option.value === codexDraft?.model)
            ?.label ?? codexDraft?.model,
        codexDraft?.speed ?? 'standard',
        codexDraft?.intelligence ?? 'medium'
    ]
        .filter((part): part is string => Boolean(part))
        .join(' · ')
    return (
        <div className='grid gap-2'>
            <GroupToggle
                open={showCodex}
                onToggle={() => setDefaultOpen((open) => !open)}
                label={t('web.agentNew.codexModelSettings')}
                summary={codexSummary}
            />
            {showCodex && (
                <div className='grid gap-2'>
                    <div>
                        <span className='text-caption text-subtle mb-1 block font-medium'>
                            {t('web.agentNew.model')}
                        </span>
                        <WorkbenchSelect
                            mono
                            size='sm'
                            ariaLabel={t('web.agentNew.model')}
                            placeholder={t('web.agentNew.chooseSupportedModel')}
                            value={codexDraft?.model ?? ''}
                            onChange={(next) => update({ model: next || null })}
                            options={[
                                {
                                    value: '',
                                    label: t(
                                        'web.agentNew.chooseSupportedModel'
                                    )
                                },
                                ...view.options.map((option) => ({
                                    value: option.value,
                                    label: option.label
                                }))
                            ]}
                        />
                    </div>
                    <div className='grid gap-2 md:grid-cols-2'>
                        <div>
                            <span className='text-caption text-subtle mb-1 block font-medium'>
                                {t('web.agentNew.speed')}
                            </span>
                            <WorkbenchSelect
                                size='sm'
                                ariaLabel={t('web.agentNew.speed')}
                                value={codexDraft?.speed ?? 'standard'}
                                onChange={(next) =>
                                    update({ speed: next as CodexSpeed })
                                }
                                options={codexSpeedOptions.map((speed) => ({
                                    value: speed,
                                    label: speed,
                                    disabled:
                                        speed === 'fast' &&
                                        !view.options.find(
                                            (o) => o.value === codexDraft?.model
                                        )?.supportsFast
                                }))}
                            />
                        </div>
                        <div>
                            <span className='text-caption text-subtle mb-1 block font-medium'>
                                {t('web.agentNew.reasoning')}
                            </span>
                            <WorkbenchSelect
                                size='sm'
                                ariaLabel={t('web.agentNew.reasoning')}
                                value={codexDraft?.intelligence ?? 'medium'}
                                onChange={(next) =>
                                    update({
                                        intelligence: next as CodexIntelligence
                                    })
                                }
                                options={codexIntelligenceOptionsForModel(
                                    codexDraft?.model
                                ).map((level) => ({
                                    value: level,
                                    label: level
                                }))}
                            />
                        </div>
                    </div>
                </div>
            )}
            {validationMessage && (
                <div className='workbench-alert-error'>{validationMessage}</div>
            )}
        </div>
    )
}
