import type { AgentModelConfigSource } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { CloudComputerIcon, TerminalIcon } from '@/components/icons'
import { useI18n } from '@/lib/i18n'

interface SegmentProps {
    title: string
    hint: string
    active: boolean
    icon: ReactNode
    onSelect: () => void
}

const ModelSourceSegment: FC<SegmentProps> = ({
    active,
    hint,
    icon,
    onSelect,
    title
}): ReactNode => {
    const head = (
        <>
            <span className='model-source-segment-icon'>{icon}</span>
            <span className='model-source-segment-title'>{title}</span>
        </>
    )
    return (
        <ShortcutTooltip label={hint} placement='bottom'>
            {active ? (
                <div
                    role='radio'
                    aria-checked={true}
                    className='model-source-segment model-source-segment-active'
                >
                    {head}
                </div>
            ) : (
                <button
                    type='button'
                    role='radio'
                    aria-checked={false}
                    onClick={onSelect}
                    className='model-source-segment model-source-segment-idle'
                >
                    {head}
                </button>
            )}
        </ShortcutTooltip>
    )
}

interface Props {
    source: AgentModelConfigSource
    onSelect: (source: AgentModelConfigSource) => void
}

const ModelSourceSwitch: FC<Props> = ({ onSelect, source }): ReactNode => {
    const { t } = useI18n()
    const local = source === 'runtime-local'
    return (
        <div
            role='radiogroup'
            aria-label={t('web.credentials.modelSourceLabel')}
            className='model-source-switch'
        >
            <ModelSourceSegment
                title={t('web.credentials.modelSourcePlatform')}
                hint={t('web.credentials.modelSourcePlatformHint')}
                active={!local}
                icon={<CloudComputerIcon className='h-4 w-4' />}
                onSelect={() => onSelect('platform')}
            />
            <ModelSourceSegment
                title={t('web.credentials.modelSourceLocal')}
                hint={t('web.credentials.modelSourceLocalHint')}
                active={local}
                icon={<TerminalIcon className='h-4 w-4' />}
                onSelect={() => onSelect('runtime-local')}
            />
        </div>
    )
}

export default ModelSourceSwitch
