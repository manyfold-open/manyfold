import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DetectedOpenclawGateway } from '@manyfold/shared'

// BYOD openclaw gateway DISCOVERY — never start (ADR-0027, Ying: "只发现，不拉起").
// The daemon reads the host's own openclaw config to learn the resident
// gateway's loopback port, probes it, and reports reachability on the
// heartbeat. It never reports the token: `openclaw acp` resolves that itself
// from the same config file at turn time (the url-less bridge).

// openclaw resolves its config under $OPENCLAW_HOME (falling back to $HOME),
// at .openclaw/openclaw.json — the same file its own CLI reads.
const openclawConfigPath = (): string =>
    join(process.env.OPENCLAW_HOME || homedir(), '.openclaw', 'openclaw.json')

const asPort = (value: unknown): number | null =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536
        ? value
        : null

// A local gateway is one bound to loopback (or an unset/`local` mode). A config
// that points openclaw at a REMOTE gateway is not ours to probe — return a null
// port so the heartbeat reports "no local gateway" rather than a misleading
// unreachable, and the turn path refuses with a typed error.
const readLocalGatewayPort = (config: unknown): number | null => {
    const gateway = (config as { gateway?: Record<string, unknown> } | null)
        ?.gateway
    if (!gateway || typeof gateway !== 'object') return null
    const mode = gateway['mode']
    if (mode !== undefined && mode !== 'local') {
        // `remote`/`tailscale`/etc.: the resident gateway, if any, is not
        // addressed by gateway.port. Treat as no local gateway.
        const remote = gateway['remote'] as Record<string, unknown> | undefined
        if (remote && typeof remote['url'] === 'string') return null
    }
    return asPort(gateway['port'])
}

// A loopback HTTP probe. openclaw's ingress answers GET / on both loopback
// families; a direct 127.0.0.1 request carries no forwarded header, so it is
// never proxy-attributed away (unlike an off-box caller). Any HTTP status —
// even 401/403 — proves the gateway is listening; only connect/timeout is
// "unreachable".
const probeGateway = async (port: number, timeoutMs = 1500): Promise<boolean> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        await fetch(`http://127.0.0.1:${port}/`, {
            method: 'GET',
            signal: controller.signal
        })
        return true
    } catch {
        return false
    } finally {
        clearTimeout(timer)
    }
}

// Discover the resident gateway for the heartbeat. Returns undefined when there
// is no readable openclaw config at all (so the DetectedFramework simply omits
// the gateway field); returns a record with a null port when the config exists
// but names no local gateway.
export const discoverOpenclawGateway = async (): Promise<
    DetectedOpenclawGateway | undefined
> => {
    let raw: string
    try {
        raw = await readFile(openclawConfigPath(), 'utf8')
    } catch {
        return undefined
    }
    let config: unknown
    try {
        config = JSON.parse(raw)
    } catch {
        return undefined
    }
    const port = readLocalGatewayPort(config)
    const checkedAt = new Date().toISOString()
    if (port === null) return { port: null, reachable: null, checkedAt }
    return { port, reachable: await probeGateway(port), checkedAt }
}
