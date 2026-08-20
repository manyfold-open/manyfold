import { readFileSync } from 'node:fs'
import type { DaemonStartupMethod } from '@manyfold/shared'
import { resolveProfile } from '@/config'
import { launchdLabelFor } from './init-unit/darwin'

export const detectStartupMethod = (): DaemonStartupMethod => {
    if (process.platform === 'darwin') {
        if (process.env.XPC_SERVICE_NAME === launchdLabelFor(resolveProfile())) {
            return (process.getuid?.() ?? -1) === 0
                ? 'launchd-system'
                : 'launchd-user'
        }
        return 'manual'
    }

    if (process.platform === 'linux') {
        if (process.env.INVOCATION_ID !== undefined) {
            let cgroup = ''
            try {
                cgroup = readFileSync('/proc/self/cgroup', 'utf8')
            } catch {}
            if (/\/user\.slice\//.test(cgroup) || /user@\d+\.service/.test(cgroup))
                return 'systemd-user'
            return 'systemd-system'
        }
        return 'manual'
    }

    return 'manual'
}
