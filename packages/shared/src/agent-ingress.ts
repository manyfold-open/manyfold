// URL composition helpers for in-cluster K8s agent ingress endpoints.
//
// Each per-agent Ingress is fronted by either:
//   - Plain HTTP (legacy, e.g. nip.io behind nginx ingress with no TLS), OR
//   - HTTPS via Cloudflare Tunnel (current default — see
//     infra/k8s/manyfold-agents-tunnel/).
//
// The scheme is selected by the K8S_INGRESS_SCHEME env var read at call time
// (default 'https'). Setting it to 'http' lets local dev / legacy clusters
// keep the old behavior without a code change.

export type AgentIngressScheme = 'http' | 'https'

export const agentIngressScheme = (
    env: NodeJS.ProcessEnv = process.env
): AgentIngressScheme =>
    (env.K8S_INGRESS_SCHEME ?? '').toLowerCase() === 'http' ? 'http' : 'https'

export const agentWsScheme = (
    env: NodeJS.ProcessEnv = process.env
): 'ws' | 'wss' => (agentIngressScheme(env) === 'http' ? 'ws' : 'wss')

export const agentBaseUrl = (ingressHost: string, path = ''): string =>
    `${agentIngressScheme()}://${ingressHost}${path}`

export const agentWsUrl = (ingressHost: string, path = ''): string =>
    `${agentWsScheme()}://${ingressHost}${path}`
