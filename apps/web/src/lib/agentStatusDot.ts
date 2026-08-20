import type { SdkAgent } from '@manyfold/sdk'

const K8S_RUNNING = new Set(['Running'])
const K8S_WARM = new Set([
    'Pending',
    'NotReady',
    'ContainerCreating',
    'PodInitializing'
])
const K8S_FAILED = new Set([
    'CrashLoopBackOff',
    'ImagePullBackOff',
    'ErrImagePull',
    'CreateContainerConfigError',
    'CreateContainerError',
    'InvalidImageName',
    'Failed',
    'Unknown'
])
const K8S_COLD = new Set(['Succeeded'])

const RED = 'bg-[#fb7185]'
const AMBER = 'bg-[#f59e0b]'
const GREEN = 'bg-[#22c55e]'
const BLUE = 'bg-[#60a5fa]'
const SLATE = 'bg-[#94a3b8]'

export const agentStatusDotClass = (
    status: SdkAgent['status'],
    spriteStatus: SdkAgent['spriteStatus'],
    k8sPodPhase: SdkAgent['k8sPodPhase'],
    runtime?: SdkAgent['runtime']
): string => {
    if (status === 'failed') return RED
    if (status === 'pending') return AMBER
    if (runtime === 'daemon' && status === 'stopped') return RED
    if (status === 'stopped') return SLATE
    if (spriteStatus === 'cold') return SLATE
    if (spriteStatus === 'warm') return BLUE
    if (k8sPodPhase) {
        if (K8S_FAILED.has(k8sPodPhase)) return RED
        if (K8S_WARM.has(k8sPodPhase)) return BLUE
        if (K8S_COLD.has(k8sPodPhase)) return SLATE
        if (K8S_RUNNING.has(k8sPodPhase)) return GREEN
    }
    return GREEN
}

export const agentStatusDotLabel = (
    status: SdkAgent['status'],
    spriteStatus: SdkAgent['spriteStatus'],
    k8sPodPhase: SdkAgent['k8sPodPhase']
): string => {
    if (status !== 'running') return status
    if (spriteStatus) return spriteStatus
    if (k8sPodPhase) return k8sPodPhase
    return status
}
