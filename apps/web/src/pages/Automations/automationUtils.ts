import { t } from '@manyfold/i18n'
export {
    modelOptionsForAgent,
    supportsModelOverride
} from '@/lib/frameworkMeta'

export const formatModelLabel = (model: string | null): string => {
    if (!model) return t('web.automations.defaultModel')
    if (/^gpt-/i.test(model)) return model.replace(/^gpt/i, 'GPT')
    if (/^gemini-/i.test(model)) return model.replace(/^gemini/i, 'Gemini')
    return model
}
