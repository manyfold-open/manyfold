import {
    AgentModelConfig,
    AgentModelConfigView,
    CodexIntelligence,
    CodexSpeed,
    claudeCodeModelMapAliases
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
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
    onTestProvider: () => void
    providerTestLabel: string
    providerTesting: boolean
    providerTestDisabled: boolean
    providerTestError: string | null
}

export const CreateFrameworkModelConfig: FC<Props> = ({
    view,
    draft,
    validationMessage,
    onChange,
    onTestProvider,
    providerTestLabel,
    providerTesting,
    providerTestDisabled,
    providerTestError
}): ReactNode => {
    const { t } = useI18n()
    if (!view) return null
    if (view.providerModelsStatus !== 'ready') {
        return (
            <div className='workbench-note space-y-3'>
                <p>{t('web.agentNew.modelConfigTestHint')}</p>
                <button
                    type='button'
                    onClick={onTestProvider}
                    disabled={providerTesting || providerTestDisabled}
                    className='workbench-button-secondary h-9'
                >
                    {providerTesting ? t('web.agentNew.testing') : providerTestLabel}
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
        return (
            <div className='grid gap-3'>
                <div className='workbench-group-label'>
                    {t('web.agentNew.claudeModelMapping')}
                </div>
                {claudeCodeModelMapAliases.map((alias) => (
                    <div key={alias} className='block'>
                        <span className='workbench-field-label capitalize'>
                            {alias}
                        </span>
                        <WorkbenchSelect
                            mono
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
                                    label: t('web.agentNew.selectProviderModel')
                                },
                                ...view.providerModels.map((model) => ({
                                    value: model,
                                    label: model
                                }))
                            ]}
                        />
                    </div>
                ))}
                <div
                    className={
                        effortOptions.length > 0
                            ? 'grid gap-3 md:grid-cols-2'
                            : 'grid gap-3'
                    }
                >
                    <div>
                        <span className='workbench-field-label'>
                            {t('web.agentNew.defaultModel')}
                        </span>
                        <WorkbenchSelect
                            ariaLabel={t('web.agentNew.defaultModel')}
                            placeholder={t('web.agentNew.selectModel')}
                            value={currentDraft?.model ?? ''}
                            onChange={(next) => update({ model: next || null })}
                            options={[
                                { value: '', label: t('web.agentNew.selectModel') },
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
                            <span className='workbench-field-label'>
                                {t('web.agentNew.effort')}
                            </span>
                            <WorkbenchSelect
                                ariaLabel={t('web.agentNew.effort')}
                                value={currentDraft?.effort ?? ''}
                                onChange={(next) =>
                                    update({
                                        effort: next as (typeof effortOptions)[number]
                                    })
                                }
                                options={effortOptions.map((effort) => ({
                                    value: effort,
                                    label: formatClaudeEffortLabel(effort, t)
                                }))}
                            />
                        </div>
                    )}
                </div>
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
    return (
        <div className='grid gap-3'>
            <div className='workbench-group-label'>
                {t('web.agentNew.codexModelSettings')}
            </div>
            <div>
                <span className='workbench-field-label'>
                    {t('web.agentNew.model')}
                </span>
                <WorkbenchSelect
                    mono
                    ariaLabel={t('web.agentNew.model')}
                    placeholder={t('web.agentNew.chooseSupportedModel')}
                    value={codexDraft?.model ?? ''}
                    onChange={(next) => update({ model: next || null })}
                    options={[
                        { value: '', label: t('web.agentNew.chooseSupportedModel') },
                        ...view.options.map((option) => ({
                            value: option.value,
                            label: option.label
                        }))
                    ]}
                />
            </div>
            <div className='grid gap-3 md:grid-cols-2'>
                <div>
                    <span className='workbench-field-label'>
                        {t('web.agentNew.speed')}
                    </span>
                    <WorkbenchSelect
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
                    <span className='workbench-field-label'>
                        {t('web.agentNew.reasoning')}
                    </span>
                    <WorkbenchSelect
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
            {validationMessage && (
                <div className='workbench-alert-error'>{validationMessage}</div>
            )}
        </div>
    )
}
