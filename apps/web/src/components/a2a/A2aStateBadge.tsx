import type { FC, ReactNode } from 'react'
import { useI18n } from '@/lib/i18n'
import { a2aStateTone } from '@/lib/a2aTaskState'
import { StatusTag } from '@/components/Tag'

interface Props {
    state: string
}

const A2aStateBadge: FC<Props> = ({ state }): ReactNode => {
    const { t } = useI18n()
    return (
        <StatusTag
            tone={a2aStateTone(state)}
            label={t(`web.backgroundTasks.states.${state}`)}
        />
    )
}

export default A2aStateBadge
