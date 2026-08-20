import type { Agent } from '@manyfold/db'

const HR = '──────────────────────────────────────────────'

export const buildStatusBanner = (agent: Agent): string => {
    const lines = [
        HR,
        ` agent    : ${agent.name} (${agent.id})`,
        ` framework: ${agent.framework}`,
        ` runtime  : ${agent.runtime}`,
        ` status   : ${agent.status}`
    ]
    if (agent.runtime === 'sprites') {
        lines.push(
            ` sprite   : ${agent.spriteName ?? '?'} (${agent.spriteId ?? '?'})`
        )
    } else if (agent.runtime === 'daemon') {
        lines.push(` daemon  : ${agent.daemonId ?? '?'}`)
    } else {
        lines.push(` namespace: ${agent.namespace ?? '?'}`)
    }
    lines.push(
        agent.runtime === 'daemon'
            ? ` workspace: ${agent.workspacePath}`
            : ` mountPath: ${agent.mountPath}`,
        HR,
        ''
    )
    return lines.join('\r\n')
}
