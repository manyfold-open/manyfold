import { apiPaths } from '@manyfold/shared'
import type { AuthHandoff } from '@/lib/auth'

// NarraNexus sends its signed-in user over with their NetMind loginToken.
export const narraNexusAuthHandoff: AuthHandoff = {
    fragmentParam: 'nmtoken',
    exchangePath: apiPaths.AUTH_NETMIND,
    credentialField: 'loginToken'
}
