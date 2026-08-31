import { EXPERIMENT_KEYS } from '@manyfold/shared'
import { Suspense, type FC, type ReactNode } from 'react'
import { Ghost } from '@/components/Loading'
import { useLoadingGate } from '@/components/useLoadingGate'
import { AGENT_CREATE_UX_FALLBACK } from '@/lib/agentCreate/createUxFallback'
import { lazyChunk } from '@/lib/lazyChunk'
import { useExperimentVariant } from '@/lib/useExperiment'

const AgentNewV1 = lazyChunk(() => import('@/pages/AgentNew/v1/AgentNewV1'))
const AgentNewBInline = lazyChunk(
    () => import('@/pages/AgentNew/v2/AgentNewBInline')
)
const AgentNewV3 = lazyChunk(() => import('@/pages/AgentNew/v3/AgentNewV3'))

const Fallback: FC = (): ReactNode => {
    const gate = useLoadingGate(true)
    if (!gate.showLoading) return null
    return (
        <div className='workbench-page-narrow' aria-busy='true'>
            <Ghost variant='title' className='w-44' />
            <Ghost variant='cap' className='mt-3 w-72 max-w-full' />
            <div className='workbench-panel mt-7 space-y-3 px-5 py-5'>
                <Ghost variant='line' className='w-1/3' />
                <Ghost variant='block' className='h-10 w-full' />
                <Ghost variant='cap' className='w-2/3' />
            </div>
        </div>
    )
}

const AgentNewRouter: FC = (): ReactNode => {
    const variant = useExperimentVariant(
        EXPERIMENT_KEYS.AGENT_CREATE_UX,
        AGENT_CREATE_UX_FALLBACK
    )
    const Component =
        variant === 'v3' || variant === 'c'
            ? AgentNewV3
            : variant === 'b' || variant === 'v2-b'
              ? AgentNewBInline
              : AgentNewV1
    return (
        <Suspense fallback={<Fallback />}>
            <Component />
        </Suspense>
    )
}

export default AgentNewRouter
