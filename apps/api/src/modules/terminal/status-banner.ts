import type { Agent } from '@manyfold/db'
import type { RuntimeContext } from '@/modules/hosts/runtime-context.service'

const HR = '──────────────────────────────────────────────'

export const buildStatusBanner = (
    ctx: Pick<RuntimeContext, 'placement' | 'host' | 'availability'> & {
        agent: Agent
    }
): string => {
    const { agent, host, placement } = ctx
    const lines = [
        HR,
        ` agent    : ${agent.name} (${agent.id})`,
        ` framework: ${agent.framework}`,
        ` runtime  : ${placement}`,
        ` status   : ${agent.status} (${ctx.availability})`
    ]
    if (host) lines.push(` host     : ${host.name} (${host.id})`)
    const ref = host?.providerRef
    if (ref?.kind === 'sprites')
        lines.push(` sprite   : ${ref.spriteName} (${ref.spriteId ?? '?'})`)
    else if (ref?.kind === 'k8s') lines.push(` namespace: ${ref.namespace}`)
    lines.push(
        placement === 'daemon'
            ? ` workspace: ${agent.workspacePath}`
            : ` mountPath: ${agent.mountPath}`,
        HR,
        ''
    )
    return lines.join('\r\n')
}
