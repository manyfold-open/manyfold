import { createHmac } from 'node:crypto'
import {
    isRouteNonce,
    normalizeRouteBaseUrl,
    routeAttestationMessage,
    type InferenceProtocol
} from '@manyfold/shared'

// The provider route a runtime resolved for a turn, as the runtime itself
// would: the wire protocol, the endpoint and the key it authenticates with.
export interface ServedRoute {
    protocol: InferenceProtocol
    baseUrl: string
    apiKey: string
}

// A route, or the reason it could not be resolved. The reason travels to the
// API as routeAttestationStatus, so it names a condition and never a value.
export type RouteResolution = { route: ServedRoute } | { unresolved: string }

export const sameRoute = (a: ServedRoute, b: ServedRoute): boolean =>
    a.protocol === b.protocol &&
    a.apiKey === b.apiKey &&
    normalizeRouteBaseUrl(a.baseUrl) === normalizeRouteBaseUrl(b.baseUrl)

// What the turn's final carries for its routeNonce.
export type RouteAttestationField =
    | { routeAttestation: string }
    | { routeAttestationStatus: string }

export const attestRoute = (
    nonce: string,
    resolution: RouteResolution
): RouteAttestationField => {
    if (!isRouteNonce(nonce))
        return { routeAttestationStatus: 'nonce_invalid' }
    if ('unresolved' in resolution)
        return { routeAttestationStatus: resolution.unresolved }
    const { route } = resolution
    const message = routeAttestationMessage({
        nonce,
        protocol: route.protocol,
        baseUrl: route.baseUrl
    })
    if (!message) return { routeAttestationStatus: 'base_url_invalid' }
    if (!route.apiKey) return { routeAttestationStatus: 'key_unresolved' }
    return {
        routeAttestation: createHmac('sha256', route.apiKey)
            .update(message)
            .digest('hex')
    }
}
